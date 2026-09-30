# Genel Kurum bağlantısı

Kullanıcının güncel temiz checkout'u `2675cde4c75459dd423c6d0b33963dd6961fcb0a`
üzerine çalışan reader/workflow/saklama değişiklikleri birleştirildi. Kullanıcının
README ve `0021_genel_kurum_template.sql` değişiklikleri korundu.

Canlı kayıt doğrulandı:

- ID: `bfd240af-f2ad-46da-a39a-8f420fe1dc34`
- Ad: `genel kurum`; MCP slug ve tek çalışma modu: `genelkurum`
- Hedef: `ucretsizderinlikbot`; tam komut: `/kurum`
- Tek adım, 3 saniye; normal mesaj metni mevcut sonuç okuma aracından alınır.

`start_command_workflow(mode="genelkurum", request_key=<sabit anahtar>,
requested_at=<yeni UTC ISO zaman>)` yalnız bu şablonu başlatır. Aynı mantıksal
isteğin tekrarında key ve requested_at değişmez; yeni iş yaratılmaz. Exact
workflow ve job kimliği izlenir; sonuçlar başka son işten alınmaz.
`list_command_result_jobs(template="genelkurum")` yalnız bu şablonu listeler.

`market_round` yalnız Terane→Kurum kalır. Dört otomasyon değiştirilmedi.
Genel Kurum mevcut üç şablonluk medya silme kapsamına eklenmedi.
Yeni public endpoint, OAuth scope veya başka client grant oluşturulmadı;
aynı tek kullanıcı/issuer/audience ve read+run kontrolleri korunur.
Yeni şablonların otomatik keşfi veya genel erişim açılması yoktur.

## Test ve yayın kanıtı

Tür kontrolü ve 212 test / 26 dosya geçti. Dört yeni test gerçek kullanıcı
şablonunu, tek Genel Kurum normal mesaj akışını, idempotency'yi, eski market_round
sırasını ve migration ile bütün satır/owner/global lock korumasını doğrular.
Gerçek yerel Workerd + D1/R2 testi yeni tek /kurum akışı ve eski auth/queue/
saklama kontrolleriyle başarılıdır. Bunlar fixture testidir, canlı iş başlatmaz.

Canlı son sürüm öncesinde hâlâ `05ff59cb` olarak doğrulandı. Yeni template
migration'ı zaten uygulanmıştı. Yalnız bekleyen `0023_genel_kurum_workflow_mode.sql`
resmî transactional D1 runner ile uygulandı; mode CHECK genişletildi. Mevcut iki
workflow'un tüm alanlarının SHA256 değeri önce ve sonra aynı kaldı:
`a3291060260180f2f2480aecdf3b3bd265e8415fa329816a247a4a5c0d3925dd`.
Önceki ücretsiz Time Travel bookmark:
`00000047-000005ce-000050f6-15aace205c38c61adaca6760a4210210`.

Etkin sürüm: `e47c3b5f-795f-4a26-ad7d-7031ee66d901`.
`--keep-vars` ile yayım; sekiz asset değişmedi, beş binding, read/run/saklama
ayarları ve mevcut cron korundu. Yayım sonrası 48 iş, 467 sonuç ve 100.088 metin
karakteri aynı kaldı. Child yeni canlı iş başlatmadı; parent tek denemeyi yapar.

Geçici Cloudflare oturumu yalnız `user:read account:read workers_scripts:write
 d1:write offline_access` idi. Resmî logout başarılı; sunucu Wrangler grant'i
Revoke edildi ve taze Chrome ekranında `No connected applications found`
doğrulandı. Ücretli özellik, push veya PR yoktur. Yeni hesabın/planın ücretsiz
kotaları değişmedi; sınırsız ücretsiz garanti verilmez.

Plugin: Heran Borsa Sonuçları. Safari ayarındaki Araçları yenile çağrısı yapıldı;
taze eklenti araç ekranında yeni Genel Kurum açıklaması ve Write 1 / Read 4
ayrımı doğrulandı. Yeni client grant veya yeniden OAuth onayı gerekmedi.

Parent gerçek tek `genelkurum` start çağrısını 11:59:16 UTC'de başarılı yaptı:
workflow `71cae346-c42b-4ab9-a57f-9738d9d6f171`, exact job
`5abdfd2e-bfea-4db8-9a52-ef2f719e26b3`, ilk durum queued. Parent aynı işi izleyip
metin/tweet/görsel kabulünü tamamlar. Child ikinci iş başlatmadı; sonuç henüz
bu checkpoint'te terminal olarak doğrulanmadı.

Teslim: `../heran-genel-kurum.patch` önceki reader/workflow/saklama çalışma
checkout'u üstüne yalnız bu bağlantı değişikliklerini içerir. `../heran-genel-kurum-combined.patch`
kullanıcının temiz güncel 2675cde checkout'u üzerine reader/workflow/saklama ve yeni
Genel Kurum desteğini birlikte içerir. İkisinin ilgili checkout üzerinde
`git apply --check` kontrolü geçti; asıl kullanıcı checkout'una uygulanmadı.
