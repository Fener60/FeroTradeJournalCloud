# Fero Trade Journal Cloud

Bu proje, Fero için bulut senkronizasyonlu işlem günlüğüdür.

## Ne otomatik?
- Telefon ve bilgisayar aynı Supabase hesabını kullanır.
- Yeni işlemde 1R = gerçekleşmiş kasanın %1'i olarak hesaplanır.
- Stop mesafesine göre pozisyon büyüklüğü, adet, otomatik kaldıraç/margin ve 3R TP hesaplanır.
- Açık işlemler Binance Futures public fiyatı üzerinden sunucuda takip edilir.
- TP3 veya SL fiyatı görülürse journal otomatik kapanır.
- Açık/unrealized PnL kasaya yazılmaz.
- Sadece CLOSED işlemin net PnL'si kasaya eklenir/çıkarılır.
- Manuel erken kapanan işlemde orijinal 3R/SL planı izlenmeye devam eder; sonuç psikoloji analizine yazılır ama kasa değişmez.
- Supabase Realtime sayesinde başka cihazdaki ekran kendiliğinden yenilenir.
- Binance hesabı bağlanırsa read-only pozisyon kontrolüyle borsadaki manuel kapanış yakalanmaya çalışılır.

## Canlıya almak için 3 ana adım

### 1) Supabase
1. https://supabase.com adresinde bir proje oluştur.
2. SQL Editor'u aç.
3. `supabase/schema.sql` dosyasının tamamını çalıştır.
4. Project Settings > API bölümünden:
   - Project URL
   - public anon/publishable key
   - service_role key
   bilgilerini al.

### 2) Sunucu
Render, Railway, Fly.io veya Node.js çalıştıran benzer bir yere bu klasörü yükle.

Environment değişkenlerini `.env.example` dosyasına göre ekle:
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- APP_ENCRYPTION_KEY

`SUPABASE_SERVICE_ROLE_KEY` ve `APP_ENCRYPTION_KEY` ASLA tarayıcıya yazılmamalı.

Başlatma komutu:
`npm start`

### 3) İlk giriş
Site adresini telefonda veya bilgisayarda aç.
- Hesap Oluştur
- E-posta + şifre
- Kasa & Kurallar bölümünde başlangıç kasanı kaydet
- Artık sadece İşlem Ekle ekranını kullanabilirsin.

## Binance bağlantısı (opsiyonel)
Public TP/SL takibi için Binance API anahtarı gerekmez.

Gerçek Binance pozisyonundaki manuel kapanışları otomatik yakalamak istersen:
- Binance'de yeni API oluştur.
- Sadece OKUMA yetkisini açık bırak.
- Futures trade ve withdrawal yetkilerini AÇMA.
- Journal > Binance ekranına Key/Secret gir.
- Secret tarayıcı localStorage'ına kaydedilmez; sunucuda AES-GCM ile şifrelenir.

## Risk modeli
Her işlemde:
- `1R = realized balance × 0.01`
- `position_notional = 1R / stop_distance_decimal`
- `TP = entry ± 3 × |entry-stop|`
- Kaldıraç, hedeflenen margin kullanımına göre önerilir ve max leverage ile sınırlandırılır.

Örnek:
Kasa 10,000 USDT → 1R = 100 USDT.
Stop %2 → pozisyon yaklaşık 5,000 USDT.
3R hedef kâr brüt 300 USDT'dir.
Fee/funding/slippage net PnL'den düşülür.

## Önemli teknik not
Public fiyat takip motoru, journal kaydı için Binance USD-M Futures price endpointini kullanır.
Bu bir borsa emri değildir; gerçek stop/TP emri açmaz. Borsadaki pozisyon güvenliği için gerçek borsa stop emrini ayrıca kullan.
