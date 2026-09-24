import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BINANCE_BASE = process.env.BINANCE_FUTURES_REST_BASE || 'https://fapi.binance.com';
const POLL_MS = Math.max(1000, Number(process.env.WATCHER_POLL_MS || 2000));
const BINANCE_SYNC_MS = Math.max(5000, Number(process.env.BINANCE_ACCOUNT_SYNC_MS || 10000));
const ENC_SECRET = process.env.APP_ENCRYPTION_KEY || 'CHANGE_ME';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Eksik Supabase environment değişkenleri.');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public', { extensions: ['html'] }));

app.get('/runtime-config.js', (_req, res) => {
  res.type('application/javascript').send(
    `window.FERO_CONFIG=${JSON.stringify({
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY
    })};`
  );
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'fero-trade-journal-cloud' }));

async function authUser(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Oturum gerekli.' });
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Oturum geçersiz.' });
    req.user = data.user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Oturum doğrulanamadı.' });
  }
}

function key32() {
  return crypto.createHash('sha256').update(String(ENC_SECRET)).digest();
}
function encryptText(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key32(), iv);
  const enc = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptText(payload) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key32(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

async function getSettings(userId) {
  const { data, error } = await admin.from('user_settings').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: created, error: insertError } = await admin.from('user_settings')
    .insert({ user_id: userId })
    .select('*')
    .single();
  if (insertError) throw insertError;
  return created;
}

async function realizedBalance(userId, settings = null) {
  const s = settings || await getSettings(userId);
  const { data, error } = await admin.from('trades').select('net_pnl').eq('user_id', userId).eq('status', 'CLOSED');
  if (error) throw error;
  return Number(s.starting_balance) + (data || []).reduce((sum, t) => sum + Number(t.net_pnl || 0), 0);
}

function tradeMath({ balance, direction, entry, stop, settings }) {
  const distance = Math.abs(entry - stop);
  const stopPct = distance / entry * 100;
  const risk = balance * 0.01;
  const positionNotional = risk / (distance / entry);
  const quantity = positionNotional / entry;
  const tp = direction === 'LONG' ? entry + distance * 3 : entry - distance * 3;

  const targetMarginMoney = Math.max(balance * (Number(settings.target_margin_pct) / 100), 0.00000001);
  const rawLeverage = Math.max(1, Math.ceil(positionNotional / targetMarginMoney));
  const leverage = Math.min(Number(settings.max_leverage), rawLeverage);
  const margin = positionNotional / leverage;
  return {
    risk, distance, stopPct, positionNotional, quantity, tp,
    leverage, margin, feasible: margin <= balance
  };
}

app.post('/api/trades', authUser, async (req, res) => {
  try {
    const symbol = String(req.body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const direction = req.body.direction === 'SHORT' ? 'SHORT' : 'LONG';
    const model = req.body.model === 'Order Block' ? 'Order Block' : 'Golden Zone';
    const entry = Number(req.body.entry_price);
    const stop = Number(req.body.stop_price);

    if (!symbol || !Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0 || stop <= 0 || entry === stop) {
      return res.status(400).json({ error: 'Coin, entry ve stop bilgileri geçersiz.' });
    }
    if (direction === 'LONG' && stop >= entry) return res.status(400).json({ error: 'LONG işlemde stop entry altında olmalı.' });
    if (direction === 'SHORT' && stop <= entry) return res.status(400).json({ error: 'SHORT işlemde stop entry üstünde olmalı.' });

    const settings = await getSettings(req.user.id);
    const balance = await realizedBalance(req.user.id, settings);
    const m = tradeMath({ balance, direction, entry, stop, settings });

    const checklist = req.body.checklist && typeof req.body.checklist === 'object' ? req.body.checklist : {};
    const checklistScore = Object.values(checklist).filter(Boolean).length;

    const payload = {
      user_id: req.user.id,
      symbol,
      direction,
      model,
      entry_type: String(req.body.entry_type || 'Confirmation Entry'),
      timeframe: req.body.timeframe || null,
      htf: req.body.htf || null,
      entry_price: entry,
      stop_price: stop,
      take_profit_price: m.tp,
      balance_at_entry: balance,
      risk_at_entry: m.risk,
      stop_pct: m.stopPct,
      position_notional: m.positionNotional,
      quantity: m.quantity,
      leverage: m.leverage,
      margin_required: m.margin,
      leverage_feasible: m.feasible,
      current_price: entry,
      current_price_at: new Date().toISOString(),
      emotion: req.body.emotion || null,
      urge: req.body.urge ? Number(req.body.urge) : null,
      checklist,
      checklist_score: checklistScore,
      reason: req.body.reason || null,
      notes: req.body.notes || null,
      binance_tracking: Boolean(settings.use_binance_sync)
    };

    const { data, error } = await admin.from('trades').insert(payload).select('*').single();
    if (error) throw error;
    res.json({ trade: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'İşlem kaydedilemedi.' });
  }
});

function calcGrossR(trade, exitPrice) {
  const d = Math.abs(Number(trade.entry_price) - Number(trade.stop_price));
  if (!d) return 0;
  return trade.direction === 'LONG'
    ? (exitPrice - Number(trade.entry_price)) / d
    : (Number(trade.entry_price) - exitPrice) / d;
}

async function closeTrade(trade, exitPrice, reason, source, eventTime, overrides = {}) {
  if (!trade || trade.status !== 'OPEN') return null;
  const settings = await getSettings(trade.user_id);
  const grossR = calcGrossR(trade, exitPrice);
  const grossPnl = overrides.grossPnl != null ? Number(overrides.grossPnl) : grossR * Number(trade.risk_at_entry);

  const fees = overrides.fees != null
    ? Math.abs(Number(overrides.fees))
    : Number(trade.position_notional) * (Number(settings.total_fee_pct) / 100);

  const funding = overrides.funding != null
    ? Number(overrides.funding)
    : Number(trade.position_notional) * (Number(settings.funding_cost_pct) / 100);

  const slippage = overrides.slippage != null
    ? Math.abs(Number(overrides.slippage))
    : Number(trade.position_notional) * (Number(settings.slippage_pct) / 100);

  const netPnl = grossPnl - fees - funding - slippage;
  const netR = netPnl / Number(trade.risk_at_entry);

  const automaticPlanExit = reason === 'AUTO_TP3' || reason === 'AUTO_SL' || reason === 'BINANCE_TP3' || reason === 'BINANCE_SL';
  const manualEarly = !automaticPlanExit && grossR > -1 && grossR < 3;

  const update = {
    status: 'CLOSED',
    close_price: exitPrice,
    close_reason: reason,
    close_source: source,
    closed_at: eventTime || new Date().toISOString(),
    gross_r: grossR,
    net_r: netR,
    gross_pnl: grossPnl,
    fees,
    funding,
    slippage,
    net_pnl: netPnl,
    manual_early_exit: manualEarly,
    plan_outcome_pending: manualEarly,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await admin.from('trades')
    .update(update)
    .eq('id', trade.id)
    .eq('status', 'OPEN')
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data;
}

app.post('/api/trades/:id/close', authUser, async (req, res) => {
  try {
    const { data: trade, error } = await admin.from('trades')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!trade || trade.status !== 'OPEN') return res.status(404).json({ error: 'Açık işlem bulunamadı.' });

    const exit = Number(req.body.exit_price);
    if (!Number.isFinite(exit) || exit <= 0) return res.status(400).json({ error: 'Çıkış fiyatı geçersiz.' });

    const closed = await closeTrade(
      trade,
      exit,
      String(req.body.reason || 'MANUAL'),
      'MANUAL',
      new Date().toISOString(),
      {
        fees: req.body.fees !== '' && req.body.fees != null ? Number(req.body.fees) : undefined,
        funding: req.body.funding !== '' && req.body.funding != null ? Number(req.body.funding) : undefined
      }
    );
    res.json({ trade: closed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'İşlem kapatılamadı.' });
  }
});

async function getPublicPrice(symbol) {
  const url = `${BINANCE_BASE}/fapi/v2/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Binance price ${r.status}`);
  const j = await r.json();
  const p = Number(j.price);
  if (!Number.isFinite(p)) throw new Error('Fiyat geçersiz');
  return p;
}

async function watcherTick() {
  try {
    const { data: openTrades, error } = await admin.from('trades').select('*').eq('status', 'OPEN');
    if (error) throw error;

    const { data: pending, error: pErr } = await admin.from('trades')
      .select('*')
      .eq('status', 'CLOSED')
      .eq('plan_outcome_pending', true);
    if (pErr) throw pErr;

    const symbols = [...new Set([...(openTrades || []), ...(pending || [])].map(t => t.symbol))];
    const prices = new Map();

    await Promise.all(symbols.map(async s => {
      try { prices.set(s, await getPublicPrice(s)); }
      catch (e) { console.error('Price error', s, e.message); }
    }));

    for (const t of openTrades || []) {
      const price = prices.get(t.symbol);
      if (!price) continue;

      await admin.from('trades').update({
        current_price: price,
        current_price_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', t.id).eq('status', 'OPEN');

      // Binance'ten görülen gerçek pozisyonlarda journal fiyat dokundu diye işlemi kapatmaz.
      // Gerçek kapanış Binance read-only hesap senkronundan gelir.
      if (t.binance_tracking && t.binance_position_seen) continue;

      const hitTP = t.direction === 'LONG'
        ? price >= Number(t.take_profit_price)
        : price <= Number(t.take_profit_price);
      const hitSL = t.direction === 'LONG'
        ? price <= Number(t.stop_price)
        : price >= Number(t.stop_price);

      if (hitTP) await closeTrade(t, Number(t.take_profit_price), 'AUTO_TP3', 'BINANCE_PUBLIC_PRICE', new Date().toISOString());
      else if (hitSL) await closeTrade(t, Number(t.stop_price), 'AUTO_SL', 'BINANCE_PUBLIC_PRICE', new Date().toISOString());
    }

    for (const t of pending || []) {
      const price = prices.get(t.symbol);
      if (!price) continue;

      const hitTP = t.direction === 'LONG'
        ? price >= Number(t.take_profit_price)
        : price <= Number(t.take_profit_price);
      const hitSL = t.direction === 'LONG'
        ? price <= Number(t.stop_price)
        : price >= Number(t.stop_price);

      if (!hitTP && !hitSL) continue;

      const planR = hitTP ? 3 : -1;
      await admin.from('trades').update({
        plan_outcome_pending: false,
        plan_outcome: hitTP ? 'TP3' : 'SL',
        plan_outcome_at: new Date().toISOString(),
        plan_outcome_r: planR,
        early_exit_difference_r: planR - Number(t.gross_r || 0),
        updated_at: new Date().toISOString()
      }).eq('id', t.id).eq('plan_outcome_pending', true);
    }
  } catch (e) {
    console.error('watcherTick', e);
  }
}

function signQuery(secret, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
  q.set('timestamp', String(Date.now()));
  q.set('recvWindow', '5000');
  const raw = q.toString();
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return `${raw}&signature=${signature}`;
}

async function binanceSigned(apiKey, apiSecret, path, params = {}) {
  const query = signQuery(apiSecret, params);
  const r = await fetch(`${BINANCE_BASE}${path}?${query}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
    signal: AbortSignal.timeout(7000)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(typeof data === 'object' ? (data.msg || JSON.stringify(data)) : text);
  return data;
}

app.get('/api/binance/status', authUser, async (req, res) => {
  const { data } = await admin.from('binance_connections')
    .select('enabled,last_sync_at,last_error,created_at')
    .eq('user_id', req.user.id)
    .maybeSingle();
  res.json({ connected: Boolean(data), connection: data || null });
});

app.post('/api/binance/connect', authUser, async (req, res) => {
  try {
    const apiKey = String(req.body.api_key || '').trim();
    const apiSecret = String(req.body.api_secret || '').trim();
    if (!apiKey || !apiSecret) return res.status(400).json({ error: 'API Key ve Secret gerekli.' });

    // Read-only test: Position Information V3
    await binanceSigned(apiKey, apiSecret, '/fapi/v3/positionRisk');

    const { error } = await admin.from('binance_connections').upsert({
      user_id: req.user.id,
      encrypted_api_key: encryptText(apiKey),
      encrypted_api_secret: encryptText(apiSecret),
      enabled: true,
      last_error: null,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;

    await admin.from('user_settings').update({ use_binance_sync: true, updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: `Binance bağlantısı doğrulanamadı: ${e.message}` });
  }
});

app.post('/api/binance/disconnect', authUser, async (req, res) => {
  await admin.from('binance_connections').delete().eq('user_id', req.user.id);
  await admin.from('user_settings').update({ use_binance_sync: false, updated_at: new Date().toISOString() })
    .eq('user_id', req.user.id);
  res.json({ ok: true });
});

function positionDirection(position) {
  const side = String(position?.positionSide || '').toUpperCase();
  if (side === 'LONG' || side === 'SHORT') return side;
  const amt = Number(position?.positionAmt || 0);
  if (amt > 0) return 'LONG';
  if (amt < 0) return 'SHORT';
  return null;
}

function protectiveStopForPosition(orders, position) {
  const direction = positionDirection(position);
  const entry = Number(position?.entryPrice || 0);
  if (!direction || !entry) return null;

  const expectedSide = direction === 'LONG' ? 'SELL' : 'BUY';
  const positionSide = String(position?.positionSide || 'BOTH').toUpperCase();

  const candidates = (orders || []).filter(order => {
    if (!order || order.symbol !== position.symbol) return false;
    const type = String(order.orderType || order.type || '').toUpperCase();
    if (type !== 'STOP' && type !== 'STOP_MARKET') return false;
    if (String(order.side || '').toUpperCase() !== expectedSide) return false;

    const orderPositionSide = String(order.positionSide || 'BOTH').toUpperCase();
    if (positionSide !== 'BOTH' && orderPositionSide !== 'BOTH' && orderPositionSide !== positionSide) return false;

    const trigger = Number(order.triggerPrice ?? order.stopPrice ?? 0);
    if (!Number.isFinite(trigger) || trigger <= 0) return false;
    return direction === 'LONG' ? trigger < entry : trigger > entry;
  });

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const pa = Number(a.triggerPrice ?? a.stopPrice ?? 0);
    const pb = Number(b.triggerPrice ?? b.stopPrice ?? 0);
    return direction === 'LONG' ? pb - pa : pa - pb;
  });
  return candidates[0];
}

async function getOpenProtectiveOrders(apiKey, apiSecret) {
  try {
    // Binance USD-M conditional orders are on the Algo service.
    const data = await binanceSigned(apiKey, apiSecret, '/fapi/v1/openAlgoOrders');
    return Array.isArray(data) ? data : [];
  } catch (algoError) {
    console.error('openAlgoOrders fallback', algoError.message);
    // Compatibility fallback for older/legacy order representations.
    const data = await binanceSigned(apiKey, apiSecret, '/fapi/v1/openOrders');
    return Array.isArray(data) ? data : [];
  }
}

async function importBinancePosition(userId, position, stopOrder, settings) {
  const direction = positionDirection(position);
  const entry = Number(position.entryPrice || 0);
  const stop = Number(stopOrder?.triggerPrice ?? stopOrder?.stopPrice ?? 0);
  const signedAmt = Number(position.positionAmt || 0);
  const quantity = Math.abs(signedAmt);
  const leverage = Math.max(1, Number(position.leverage || 1));

  if (!direction || !entry || !stop || !quantity) return null;
  if (direction === 'LONG' && stop >= entry) return null;
  if (direction === 'SHORT' && stop <= entry) return null;

  const balance = await realizedBalance(userId, settings);
  const distance = Math.abs(entry - stop);
  const stopPct = distance / entry * 100;
  const target1R = balance * 0.01;
  const positionNotional = quantity * entry;
  const tp = direction === 'LONG' ? entry + distance * 3 : entry - distance * 3;
  const margin = positionNotional / leverage;
  const checklist = settings.rules && typeof settings.rules === 'object' ? settings.rules : {};
  const checklistScore = Object.values(checklist).filter(Boolean).length;
  const actualStopRisk = quantity * distance;

  const payload = {
    user_id: userId,
    symbol: String(position.symbol || '').toUpperCase(),
    direction,
    model: 'Golden Zone',
    entry_type: 'Binance Auto Import',
    timeframe: null,
    htf: null,
    entry_price: entry,
    stop_price: stop,
    take_profit_price: tp,
    balance_at_entry: balance,
    risk_at_entry: target1R,
    stop_pct: stopPct,
    position_notional: positionNotional,
    quantity,
    leverage,
    margin_required: margin,
    leverage_feasible: margin <= balance,
    current_price: Number(position.markPrice || entry),
    current_price_at: new Date().toISOString(),
    checklist,
    checklist_score: checklistScore,
    reason: 'Binance Futures pozisyonundan otomatik içe aktarıldı.',
    notes: `Binance Auto Import · 1R hedefi ${target1R.toFixed(8)} · Pozisyonun SL riski ${actualStopRisk.toFixed(8)}`,
    binance_tracking: true,
    binance_position_seen: true,
    binance_last_position_amt: signedAmt,
    binance_sync_note: 'Binance pozisyonu ve koruyucu SL emri otomatik algılandı.'
  };

  const { data, error } = await admin.from('trades').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

async function syncBinanceConnection(c) {
  const apiKey = decryptText(c.encrypted_api_key);
  const apiSecret = decryptText(c.encrypted_api_secret);
  const settings = await getSettings(c.user_id);

  const positionsRaw = await binanceSigned(apiKey, apiSecret, '/fapi/v3/positionRisk');
  const positions = (Array.isArray(positionsRaw) ? positionsRaw : [positionsRaw])
    .filter(p => p && Math.abs(Number(p.positionAmt || 0)) > 0 && Number(p.entryPrice || 0) > 0);

  const protectiveOrders = positions.length
    ? await getOpenProtectiveOrders(apiKey, apiSecret)
    : [];

  let { data: openTrades, error: openErr } = await admin.from('trades')
    .select('*')
    .eq('user_id', c.user_id)
    .eq('status', 'OPEN')
    .eq('binance_tracking', true);
  if (openErr) throw openErr;
  openTrades = openTrades || [];

  let imported = 0;
  let waitingForStop = 0;

  for (const position of positions) {
    const direction = positionDirection(position);
    if (!direction) continue;

    const existing = openTrades.find(t =>
      t.symbol === position.symbol &&
      t.direction === direction
    );

    if (existing) {
      await admin.from('trades').update({
        binance_position_seen: true,
        binance_last_position_amt: Number(position.positionAmt || 0),
        binance_sync_note: existing.entry_type === 'Binance Auto Import'
          ? 'Binance otomatik pozisyon takibi aktif.'
          : 'Journal işlemi Binance pozisyonuyla eşleştirildi.',
        updated_at: new Date().toISOString()
      }).eq('id', existing.id);
      continue;
    }

    const stopOrder = protectiveStopForPosition(protectiveOrders, position);
    if (!stopOrder) {
      waitingForStop++;
      continue;
    }

    const created = await importBinancePosition(c.user_id, position, stopOrder, settings);
    if (created) {
      imported++;
      openTrades.push(created);
    }
  }

  // Importtan sonra tüm açık Binance takipli journal işlemlerini gerçek pozisyon durumu ile eşleştir.
  const { data: trackedRows, error: trackedErr } = await admin.from('trades')
    .select('*')
    .eq('user_id', c.user_id)
    .eq('status', 'OPEN')
    .eq('binance_tracking', true);
  if (trackedErr) throw trackedErr;

  for (const t of trackedRows || []) {
    const matching = positions.filter(p =>
      p.symbol === t.symbol &&
      positionDirection(p) === t.direction &&
      Math.abs(Number(p.positionAmt || 0)) > 0
    );

    const signedAmt = matching.reduce((sum, p) => sum + Number(p.positionAmt || 0), 0);
    const absAmt = matching.reduce((sum, p) => sum + Math.abs(Number(p.positionAmt || 0)), 0);

    if (absAmt > 0) {
      await admin.from('trades').update({
        binance_position_seen: true,
        binance_last_position_amt: signedAmt,
        binance_sync_note: t.entry_type === 'Binance Auto Import'
          ? 'Binance otomatik pozisyon takibi aktif.'
          : 'Binance pozisyonu görüldü.',
        updated_at: new Date().toISOString()
      }).eq('id', t.id);
      continue;
    }

    if (!t.binance_position_seen) continue;

    let exitPrice = Number(t.current_price || t.entry_price);
    let grossPnl;
    let fees;

    try {
      const startTime = new Date(t.created_at).getTime();
      const userTrades = await binanceSigned(apiKey, apiSecret, '/fapi/v1/userTrades', {
        symbol: t.symbol,
        startTime,
        limit: 1000
      });

      if (Array.isArray(userTrades) && userTrades.length) {
        const rows = userTrades.filter(x => {
          const ps = String(x.positionSide || 'BOTH').toUpperCase();
          if (ps === 'BOTH') return true;
          return ps === t.direction;
        });
        const used = rows.length ? rows : userTrades;
        exitPrice = Number(used[used.length - 1].price || exitPrice);
        grossPnl = used.reduce((s, x) => s + Number(x.realizedPnl || 0), 0);
        fees = used.reduce((s, x) => s + Math.abs(Number(x.commission || 0)), 0);
      }
    } catch (e) {
      console.error('userTrades fallback', e.message);
    }

    const exitR = calcGrossR(t, exitPrice);
    const reason = exitR <= -0.95
      ? 'BINANCE_SL'
      : exitR >= 2.95
        ? 'BINANCE_TP3'
        : 'BINANCE_MANUAL_CLOSE';

    await closeTrade(t, exitPrice, reason, 'BINANCE_READ_ONLY', new Date().toISOString(), {
      grossPnl,
      fees
    });
  }

  await admin.from('binance_connections').update({
    last_sync_at: new Date().toISOString(),
    last_error: waitingForStop
      ? `${waitingForStop} açık pozisyon için koruyucu SL bekleniyor.`
      : null,
    updated_at: new Date().toISOString()
  }).eq('user_id', c.user_id);

  return { positions: positions.length, imported, waitingForStop };
}

app.post('/api/binance/sync-now', authUser, async (req, res) => {
  try {
    const { data: connection, error } = await admin.from('binance_connections')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('enabled', true)
      .maybeSingle();
    if (error) throw error;
    if (!connection) return res.status(404).json({ error: 'Binance bağlantısı bulunamadı.' });

    const result = await syncBinanceConnection(connection);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: `Binance senkronu başarısız: ${e.message}` });
  }
});

async function binanceAccountSync() {
  try {
    const { data: conns, error } = await admin.from('binance_connections').select('*').eq('enabled', true);
    if (error) throw error;

    for (const c of conns || []) {
      try {
        await syncBinanceConnection(c);
      } catch (e) {
        await admin.from('binance_connections').update({
          last_error: e.message,
          updated_at: new Date().toISOString()
        }).eq('user_id', c.user_id);
      }
    }
  } catch (e) {
    console.error('binanceAccountSync', e);
  }
}

setInterval(watcherTick, POLL_MS);
setInterval(binanceAccountSync, BINANCE_SYNC_MS);
watcherTick();

app.get('*', (_req, res) => res.sendFile(new URL('./public/index.html', import.meta.url).pathname));

app.listen(PORT, () => console.log(`Fero Trade Journal Cloud :${PORT}`));
