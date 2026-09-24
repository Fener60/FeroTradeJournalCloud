import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const config = window.FERO_CONFIG;
const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

let session = null;
let settings = null;
let trades = [];
let realtimeChannel = null;

const defaultRules = [
  ['htf_alignment','Entry TF ve HTF aynı yönde mi?'],
  ['zone_touch','GZ / HTF OB bölgesine wick/fiyat teması oldu mu?'],
  ['internal_structure','Trend yönünde internal CHoCH/BOS teyidi var mı?'],
  ['peak_dip','Peak / Dip filtresi uygun mu?'],
  ['quality_07','0.7 kalite filtresi geçti mi?'],
  ['technical_stop','Stop teknik invalidation noktasında mı?'],
  ['target_3r','3R hedef planını işlemden önce kabul ettim mi?'],
  ['setup_not_urge','Bu işlemi setup olduğu için mi alıyorum, dürtü için değil mi?']
];

const $ = id => document.getElementById(id);
const n = v => Number(v || 0);

function money(v){
  const cur = settings?.currency || 'USDT';
  const value = n(v);
  if(cur==='TRY') return new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY',maximumFractionDigits:2}).format(value);
  if(cur==='USD') return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
  return value.toLocaleString('tr-TR',{maximumFractionDigits:2})+' USDT';
}
function fmt(v,d=2){return n(v).toLocaleString('tr-TR',{maximumFractionDigits:d})}
function token(){return session?.access_token || ''}
async function api(path, opts={}){
  const headers={...(opts.headers||{}),'Content-Type':'application/json','Authorization':`Bearer ${token()}`};
  const r=await fetch(path,{...opts,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||'İstek başarısız.');
  return data;
}
function realizedBalance(){
  return n(settings?.starting_balance)+trades.filter(t=>t.status==='CLOSED').reduce((s,t)=>s+n(t.net_pnl),0);
}
function current1R(){return realizedBalance()*0.01}
function grossR(t, price){
  const d=Math.abs(n(t.entry_price)-n(t.stop_price)); if(!d)return 0;
  return t.direction==='LONG'?(n(price)-n(t.entry_price))/d:(n(t.entry_price)-n(price))/d;
}

function setMsg(el,text,type=''){el.textContent=text||'';el.className='msg '+type}

async function bootstrap(){
  const {data:{session:s}}=await supabase.auth.getSession();
  session=s;
  renderAuth();
  if(session) await loadAll();
}
function renderAuth(){
  $('authScreen').classList.toggle('hidden',Boolean(session));
  $('app').classList.toggle('hidden',!session);
}

$('loginBtn').onclick=async()=>{
  setMsg($('authMsg'),'Giriş yapılıyor…');
  const {data,error}=await supabase.auth.signInWithPassword({email:$('authEmail').value.trim(),password:$('authPassword').value});
  if(error)return setMsg($('authMsg'),error.message,'error');
  session=data.session;renderAuth();await loadAll();
};
$('signupBtn').onclick=async()=>{
  setMsg($('authMsg'),'Hesap oluşturuluyor…');
  const {data,error}=await supabase.auth.signUp({email:$('authEmail').value.trim(),password:$('authPassword').value});
  if(error)return setMsg($('authMsg'),error.message,'error');
  setMsg($('authMsg'),data.session?'Hesap oluşturuldu.':'Hesap oluşturuldu. E-postana doğrulama geldiyse onayla.','ok');
  if(data.session){session=data.session;renderAuth();await loadAll()}
};
$('logoutBtn').onclick=async()=>{await supabase.auth.signOut();session=null;trades=[];settings=null;if(realtimeChannel)await supabase.removeChannel(realtimeChannel);renderAuth()};

supabase.auth.onAuthStateChange(async(_event,s)=>{session=s;renderAuth();if(session&&!settings)await loadAll()});

async function ensureSettings(){
  const {data,error}=await supabase.from('user_settings').select('*').eq('user_id',session.user.id).maybeSingle();
  if(error)throw error;
  if(data){settings=data;return}
  const {data:created,error:e2}=await supabase.from('user_settings').insert({user_id:session.user.id}).select('*').single();
  if(e2)throw e2;settings=created;
}
async function loadTrades(){
  const {data,error}=await supabase.from('trades').select('*').order('created_at',{ascending:false});
  if(error)throw error; trades=data||[]; localStorage.setItem('fero_last_trades',JSON.stringify(trades));
}
async function loadAll(){
  try{
    $('syncState').textContent='Buluttan yükleniyor…';
    await ensureSettings();await loadTrades();renderAll();subscribeRealtime();
    $('syncState').textContent='Bulut senkronu aktif';
  }catch(e){
    console.error(e);
    $('syncState').textContent='Bulut bağlantısı yok — son önbellek gösteriliyor';
    const cache=localStorage.getItem('fero_last_trades');if(cache){trades=JSON.parse(cache);renderAll()}
  }
}
function subscribeRealtime(){
  if(realtimeChannel)supabase.removeChannel(realtimeChannel);
  realtimeChannel=supabase.channel('fero-trades')
    .on('postgres_changes',{event:'*',schema:'public',table:'trades',filter:`user_id=eq.${session.user.id}`},async()=>{await loadTrades();renderAll();$('syncState').textContent='Senkronlandı · '+new Date().toLocaleTimeString('tr-TR')})
    .subscribe();
}

document.querySelectorAll('.nav[data-page]').forEach(btn=>{
  btn.onclick=()=>{document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$(btn.dataset.page).classList.add('active');$('pageTitle').textContent=btn.textContent;if(btn.dataset.page==='binance')loadBinanceStatus()}
});

function renderChecklist(){
  $('checklist').innerHTML=defaultRules.map(([k,label])=>`<label class="check"><input type="checkbox" data-check="${k}"><span>${label}</span></label>`).join('');
}
function checklistObject(){const o={};document.querySelectorAll('[data-check]').forEach(x=>o[x.dataset.check]=x.checked);return o}

$('saveTradeBtn').onclick=async()=>{
  try{
    const body={
      symbol:$('tSymbol').value, direction:$('tDirection').value, model:$('tModel').value,
      entry_type:$('tEntryType').value, entry_price:n($('tEntry').value), stop_price:n($('tStop').value),
      timeframe:$('tTf').value, htf:$('tHtf').value, emotion:$('tEmotion').value, urge:n($('tUrge').value),
      reason:$('tReason').value,notes:$('tNotes').value,checklist:checklistObject()
    };
    const score=Object.values(body.checklist).filter(Boolean).length;
    if(score<defaultRules.length&&!confirm(`${score}/${defaultRules.length} kural işaretli. İşlem eklemeyi engellemiyorum. Yine de kaydetmek istiyor musun?`))return;
    $('saveTradeBtn').disabled=true;setMsg($('saveTradeMsg'),'Hesaplanıyor ve buluta kaydediliyor…');
    const out=await api('/api/trades',{method:'POST',body:JSON.stringify(body)});
    setMsg($('saveTradeMsg'),`Kaydedildi. 1R ${money(out.trade.risk_at_entry)} · 3R hedef ${fmt(out.trade.take_profit_price,8)} · ${out.trade.leverage}x`,'ok');
    ['tSymbol','tEntry','tStop','tReason','tNotes'].forEach(id=>$(id).value='');document.querySelectorAll('[data-check]').forEach(x=>x.checked=false);
    await loadTrades();renderAll();
  }catch(e){setMsg($('saveTradeMsg'),e.message,'error')}
  finally{$('saveTradeBtn').disabled=false}
};

function renderDashboard(){
  const closed=trades.filter(t=>t.status==='CLOSED'),open=trades.filter(t=>t.status==='OPEN');
  const balance=realizedBalance(),net=balance-n(settings.starting_balance);
  const wins=closed.filter(t=>n(t.net_pnl)>0).length;
  const netRs=closed.map(t=>n(t.net_r));
  const expectancy=netRs.length?netRs.reduce((a,b)=>a+b,0)/netRs.length:0;
  const totalR=netRs.reduce((a,b)=>a+b,0);
  const openRisk=open.reduce((s,t)=>s+n(t.risk_at_entry),0);

  let eq=n(settings.starting_balance),peak=eq,maxDD=0,lossStreak=0,maxLossStreak=0;
  const chrono=[...closed].sort((a,b)=>new Date(a.closed_at)-new Date(b.closed_at));
  const eqPoints=[eq];
  for(const t of chrono){eq+=n(t.net_pnl);eqPoints.push(eq);peak=Math.max(peak,eq);if(peak>0)maxDD=Math.max(maxDD,(peak-eq)/peak*100);if(n(t.net_pnl)<0){lossStreak++;maxLossStreak=Math.max(maxLossStreak,lossStreak)}else lossStreak=0}

  $('dBalance').textContent=money(balance);$('d1r').textContent=money(balance*.01);$('d3r').textContent=money(balance*.03);
  $('dNet').textContent=(net>=0?'+':'')+money(net);$('dNet').className=net>=0?'green':'red';
  $('dWin').textContent=(closed.length?wins/closed.length*100:0).toFixed(1)+'%';
  $('dExp').textContent=(expectancy>=0?'+':'')+expectancy.toFixed(2)+'R';$('dTotalR').textContent=(totalR>=0?'+':'')+totalR.toFixed(2)+'R';
  $('dDD').textContent=maxDD.toFixed(2)+'%';$('dLossStreak').textContent=String(maxLossStreak);$('dOpenRisk').textContent=money(openRisk);

  $('recentTrades').innerHTML=trades.slice(0,7).map(t=>`<div class="box"><b>${t.symbol}</b> · ${t.direction} · ${t.model} · ${t.status==='OPEN'?'AÇIK':((n(t.net_r)>=0?'+':'')+n(t.net_r).toFixed(2)+'R')}</div>`).join('')||'<div class="box">Henüz işlem yok.</div>';
  renderEquity(eqPoints);
  renderModelStats(closed);
}
function renderEquity(values){
  const svg=$('equityChart');const w=900,h=240,pad=18;
  const min=Math.min(...values),max=Math.max(...values);const span=Math.max(max-min,1);
  const pts=values.map((v,i)=>`${pad+(values.length===1?0:i/(values.length-1)*(w-pad*2))},${h-pad-(v-min)/span*(h-pad*2)}`).join(' ');
  svg.innerHTML=`<line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}"></line><polyline points="${pts}"></polyline>`;
}
function renderModelStats(closed){
  const models=['Golden Zone','Order Block'];
  $('modelStats').innerHTML=models.map(m=>{const a=closed.filter(t=>t.model===m);const wins=a.filter(t=>n(t.net_pnl)>0).length;const r=a.reduce((s,t)=>s+n(t.net_r),0);return `<div class="box"><b>${m}</b><br>${a.length} işlem · Win ${(a.length?wins/a.length*100:0).toFixed(1)}% · ${(r>=0?'+':'')+r.toFixed(2)}R</div>`}).join('');
}

function psychMessage(t,r){
  if(r<0&&r>-1)return `<div class="box warn"><b>${r.toFixed(2)}R ekside.</b><br><br>Stop henüz gelmediyse: teknik invalidation oldu mu? Ters CHoCH/BOS oluştu mu? Yoksa sadece PnL mı kırmızı?</div>`;
  if(r<=-1)return `<div class="box warn"><b>Stop bölgesi.</b><br><br>Stopu korkuyla genişletme. Planı kontrol et.</div>`;
  if(r>=0&&r<3)return `<div class="box good"><b>+${r.toFixed(2)}R.</b><br><br>Planın 3R. Kâr gördüğün için hedefi plansız uzatma veya erkenden bozma.</div>`;
  return `<div class="box good"><b>3R hedef bölgesi.</b></div>`;
}
function renderOpen(){
  const open=trades.filter(t=>t.status==='OPEN');
  $('openTrades').innerHTML=open.map(t=>{const p=n(t.current_price||t.entry_price),r=grossR(t,p),upnl=r*n(t.risk_at_entry);
    return `<div class="trade"><div class="trade-head"><div><span class="symbol">${t.symbol}</span> <span class="badge ${t.direction==='LONG'?'long':'short'}">${t.direction}</span></div><b class="${r>=0?'green':'red'}">${r>=0?'+':''}${r.toFixed(2)}R</b></div>
    <div class="trade-stats">
      <div class="stat"><small>Entry</small><b>${fmt(t.entry_price,8)}</b></div><div class="stat"><small>Stop</small><b>${fmt(t.stop_price,8)}</b></div><div class="stat"><small>3R TP</small><b>${fmt(t.take_profit_price,8)}</b></div>
      <div class="stat"><small>1R</small><b>${money(t.risk_at_entry)}</b></div><div class="stat"><small>Stop %</small><b>${n(t.stop_pct).toFixed(3)}%</b></div>
      <div class="stat"><small>Pozisyon</small><b>${money(t.position_notional)}</b></div><div class="stat"><small>Kaldıraç</small><b>${t.leverage}x</b></div><div class="stat"><small>Margin</small><b>${money(t.margin_required)}</b></div>
      <div class="stat"><small>Canlı Fiyat</small><b>${fmt(p,8)}</b></div><div class="stat"><small>Gerçekleşmemiş K/Z</small><b class="${upnl>=0?'green':'red'}">${upnl>=0?'+':''}${money(upnl)}</b></div>
    </div>${psychMessage(t,r)}
    <button class="secondary close-trade" data-id="${t.id}" data-price="${p}">Manuel Kapat</button></div>`}).join('')||'<div class="panel">Açık işlem yok. Setup yoksa işlem açmamak normaldir.</div>';
  document.querySelectorAll('.close-trade').forEach(b=>b.onclick=()=>openClose(b.dataset.id,b.dataset.price));
}
function openClose(id,price){$('closeTradeId').value=id;$('closePrice').value=price;$('closeFees').value='';$('closeFunding').value='';$('closeModal').classList.add('active')}
$('cancelCloseBtn').onclick=()=> $('closeModal').classList.remove('active');
$('confirmCloseBtn').onclick=async()=>{
  try{setMsg($('closeMsg'),'Kapatılıyor…');await api(`/api/trades/${$('closeTradeId').value}/close`,{method:'POST',body:JSON.stringify({exit_price:n($('closePrice').value),reason:$('closeReason').value,fees:$('closeFees').value,funding:$('closeFunding').value})});$('closeModal').classList.remove('active');setMsg($('closeMsg'),'');await loadTrades();renderAll()}catch(e){setMsg($('closeMsg'),e.message,'error')}
};

function renderHistory(){
  const closed=trades.filter(t=>t.status==='CLOSED');
  $('historyBody').innerHTML=closed.map(t=>`<tr><td>${new Date(t.closed_at||t.created_at).toLocaleString('tr-TR')}</td><td>${t.symbol}</td><td>${t.direction}</td><td>${t.model}</td><td>${money(t.risk_at_entry)}</td><td class="${n(t.net_r)>=0?'green':'red'}">${n(t.net_r)>=0?'+':''}${n(t.net_r).toFixed(2)}R</td><td class="${n(t.net_pnl)>=0?'green':'red'}">${n(t.net_pnl)>=0?'+':''}${money(t.net_pnl)}</td><td>${t.close_reason||'-'}</td><td>${t.plan_outcome?`${t.plan_outcome} (${n(t.plan_outcome_r)>=0?'+':''}${n(t.plan_outcome_r).toFixed(0)}R) · fark ${n(t.early_exit_difference_r).toFixed(2)}R`:t.plan_outcome_pending?'Takip devam ediyor':'-'}</td></tr>`).join('')||'<tr><td colspan="9">Kapanmış işlem yok.</td></tr>';
}

function renderPsych(){
  const early=trades.filter(t=>t.manual_early_exit);
  const done=early.filter(t=>t.plan_outcome);
  const wouldTP=done.filter(t=>t.plan_outcome==='TP3').length;
  const avgDiff=done.length?done.reduce((s,t)=>s+n(t.early_exit_difference_r),0)/done.length:0;
  $('earlyExitStats').innerHTML=`<div class="box">Erken kapatılan: <b>${early.length}</b></div><div class="box">Sonradan 3R'ye giden: <b>${wouldTP}</b></div><div class="box">Ortalama plan farkı: <b>${avgDiff>=0?'+':''}${avgDiff.toFixed(2)}R</b></div>`;
}

function renderSettings(){
  $('sBalance').value=settings.starting_balance;$('sCurrency').value=settings.currency;$('sMaxLev').value=settings.max_leverage;$('sMarginPct').value=settings.target_margin_pct;$('sFeePct').value=settings.total_fee_pct;$('sFundingPct').value=settings.funding_cost_pct;$('sSlippagePct').value=settings.slippage_pct;
  $('rulesList').innerHTML=defaultRules.map(([k,label])=>`<label class="check"><input type="checkbox" data-rule="${k}" ${settings.rules?.[k]!==false?'checked':''}><span>${label}</span></label>`).join('');
}
$('saveSettingsBtn').onclick=async()=>{
  try{
    const rules={};document.querySelectorAll('[data-rule]').forEach(x=>rules[x.dataset.rule]=x.checked);
    const payload={user_id:session.user.id,starting_balance:n($('sBalance').value),currency:$('sCurrency').value,max_leverage:n($('sMaxLev').value),target_margin_pct:n($('sMarginPct').value),total_fee_pct:n($('sFeePct').value),funding_cost_pct:n($('sFundingPct').value),slippage_pct:n($('sSlippagePct').value),rules,updated_at:new Date().toISOString()};
    const {data,error}=await supabase.from('user_settings').upsert(payload).select('*').single();if(error)throw error;settings=data;renderAll();setMsg($('settingsMsg'),'Kaydedildi.','ok');
  }catch(e){setMsg($('settingsMsg'),e.message,'error')}
};

async function loadBinanceStatus(){
  if(!session)return;
  try{const x=await api('/api/binance/status');$('binanceStatus').innerHTML=x.connected?`<b class="green">Bağlı</b><br>Son senkron: ${x.connection.last_sync_at?new Date(x.connection.last_sync_at).toLocaleString('tr-TR'):'Henüz yok'}${x.connection.last_error?'<br><span class="red">'+x.connection.last_error+'</span>':''}`:'<b>Bağlı değil.</b> Public TP/SL takibi yine çalışır.'}catch(e){$('binanceStatus').textContent=e.message}
}
$('binanceConnectBtn').onclick=async()=>{try{setMsg($('binanceMsg'),'Doğrulanıyor…');await api('/api/binance/connect',{method:'POST',body:JSON.stringify({api_key:$('bApiKey').value,api_secret:$('bApiSecret').value})});$('bApiKey').value='';$('bApiSecret').value='';setMsg($('binanceMsg'),'Read-only bağlantı kuruldu.','ok');await ensureSettings();await loadBinanceStatus()}catch(e){setMsg($('binanceMsg'),e.message,'error')}};
$('binanceDisconnectBtn').onclick=async()=>{try{await api('/api/binance/disconnect',{method:'POST',body:'{}'});setMsg($('binanceMsg'),'Bağlantı kaldırıldı.','ok');await ensureSettings();await loadBinanceStatus()}catch(e){setMsg($('binanceMsg'),e.message,'error')}};

function renderAdd(){
  $('add1R').textContent=money(current1R());
  const today=new Date().toDateString(),count=trades.filter(t=>new Date(t.created_at).toDateString()===today).length;
  $('addWarning').innerHTML=count>=3?`<div class="box warn">Bugün ${count} işlem kaydın var. Yeni işlem engellenmiyor. Sadece şunu sor: Bu yeni setup mı, yoksa işlem yapma dürtüsü mü?</div>`:'';
}
function renderAll(){renderDashboard();renderOpen();renderHistory();renderPsych();renderSettings();renderAdd()}

$('exportJsonBtn').onclick=()=>download('fero-journal-backup.json',JSON.stringify({exported_at:new Date().toISOString(),settings,trades},null,2),'application/json');
$('exportCsvBtn').onclick=()=>{const head=['date','symbol','direction','model','entry','stop','tp','gross_r','net_r','net_pnl','close_reason'];const rows=trades.map(t=>[t.created_at,t.symbol,t.direction,t.model,t.entry_price,t.stop_price,t.take_profit_price,t.gross_r,t.net_r,t.net_pnl,t.close_reason].map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(','));download('fero-journal.csv',[head.join(','),...rows].join('\n'),'text/csv')};
function download(name,data,type){const b=new Blob([data],{type}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=name;a.click();URL.revokeObjectURL(u)}

renderChecklist();
bootstrap();
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
