# Önceki günün komut medyasını saklama

## Kesin kapsam

Yalnız Terane, Kurum ve Son Halka Arzlar; işin `created_at` tarihi
`Europe/Istanbul` saat diliminde tam önceki gün olmalıdır. Kaynak piyasa zamanı
bilinmiyorsa tahmin edilmez. Bugünkü ve daha eski günlerin dosyaları bu kapsamda
silinmez. AKD Terane, KAP, SPK, RSS, asset ve başka prefix'ler korunur.

İş terminal olmalı ve en az bir saattir bitmiş olmalıdır. Çalışan veya inceleme
bekleyen workflow'un tamamlanmış ilk işi dahil tüm işleri korunur. Yakın zamanda
işlenen Telegram teslimatı ve 24 saatlik bildirimi tekrar deneme penceresi korunur.
Koruma ya da hata nedeniyle gün sınırını kaçıran dosya sonraki gün otomatik olarak
kapsama genişletilmez; operatör incelemesi gerekir.

Yalnız kesin `commands/<UUID>/tek-dosya` anahtarları ve görsel/PDF türleri seçilir;
birleştirilmiş PDF dahildir. Metin/CSV ve iç içe veya şüpheli anahtarlar seçilmez.
Komut sonuç satırları, bütün metinler, iş kimlikleri ve tarihler değişmez.
`command_media_expirations` ayrı denetim tablosunda dosya durumu tutulur. Silinmiş
medya okuması R2 GET yapmadan `410 media_expired` döner; sonuç metni okunabilir ve
`media_state=expired` olur. Piyasa miktarı sıfır olarak yorumlanmaz.

## Sınırlı işlem ve silmeden listeleme

`COMMAND_MEDIA_RETENTION_MODE`: verilmemiş/`off`, `dry_run`, `delete`.
Varsayılan kapalıdır; yeni tablo olmadan eski yayın çalışır. 0022 uygulandıktan
sonra açıkça `off` kullanmak, geçmiş silinmiş dosya durumunu okumayı sürdürür.
Mevcut dakikalık cron kullanılır; yeni cron veya OAuth izni yoktur.

Bir tur en fazla 2 iş, iş başına 20 R2 nesnesi işler. R2 liste cursor'u korunur;
medya gövdesi indirilmez. Tek temizlik lease'i vardır. Her DELETE öncesinde işin
uygunluğu yeniden doğrulanır. Silme ve denetim yazma kesintileri kesin anahtar
üzerinden uzlaştırılır; üç başarısız denemeden sonra otomatik deneme durur ve
inceleme işareti yazılır. Sabit hata kodları gizli sağlayıcı ayrıntılarını içermez.
Silme başladığında iş mühürlenir; eski PDF teslimatı dosyayı yeniden yaratamaz.

Operatör yardımcısı `previewCommandMediaRetention` yalnız SELECT + sınırlı R2 LIST
kullanır; dış HTTP aracı değildir. `dry_run` cron'u aynı sınırla tüm sayfa ve işleri
ilerleyerek özel D1 `system_state` raporlarını biriktirir:

- `command_media_retention:preview`: son sınırlı tur, aday toplamı ve sayfa sınırları.
- `command_media_retention:preview-job:<Türkiye günü>:<iş UUID>`: işin kesin dosya
  listesi, byte boyutları, `has_more` ve sonraki cursor. Her işte `has_more=false`
  olmadan tam liste incelenmiş sayılmaz.
- `command_media_retention:preview-done:<Türkiye günü>:<iş UUID>`: tamamlanmış
  listeleme. Bu işaret silme anlamına gelmez.
- `command_media_retention:last_result`: silme sayısı, byte, hata ve kontrol zamanı.

Bu özel raporlardaki anahtarlar chat'te veya herkese açık belgede paylaşılmaz.
Listeleme dosyaları değiştirmez. Ücretsiz R2 depolama birikimini azaltır; Class A/B
istekleri ve hesabın başka yazıcıları için sınırsız ücretsiz garanti vermez.

## Doğrulama ve yayın

`npm run check`, `npm test`: 208 test / 25 dosya başarılı.
`npm run test:workflows:runtime`: gerçek yerel Workerd + D1 + R2 fixture başarılı.
Testler Türkiye gece yarısı, üç şablon/tarih/iş kapsamı, aktif workflow koruması,
13 saklama testi, bütün sayfaların silmeden taranması, 20 nesne sınırı, tekrar
hataları, kesinti uzlaştırması, metinlerin korunması ve eski medya 410'u kapsar.
Fixture üzerinde silme testleri canlı dosyalara dokunmaz.

Canlı adımlar yalnız aynı Heran Borsa Worker ve D1'e uygulanır. Önce yalnız 0022
tablosu/index'i; mevcut satırlara veri değişikliği yok. Sonra `--keep-vars` ile
`dry_run` yayını; read/run ayarları, beş binding, sekiz asset ve mevcut cron korunur.
Gerçek önceki gün adaylarının tüm özel raporları incelenir. Kapsamı doğrulamadan
`delete` açılmaz. Kalıcı silme eylemi ek anlık onay isterse durulur.
Yayının sonunda resmî Wrangler logout ve sunucu tarafında grant Revoke yapılır.

Rollback: önce saklama `off`; bu yeni silmeleri durdurur fakat önceki R2 silmeleri
geri alınamaz. Yeni D1 tablosu bırakılır, metin/iş satırları silinmez. Aktif workflow
varken eski claim koduna dönülmez. Ücretli yedek veya yeni hizmet kullanılmaz.

## 30 Eylül canlı listeleme aşaması

Doğru hesapta tam beş geçici izin doğrulandı. Öncesindeki ücretsiz D1 Time Travel
bookmark: `00000045-000054b7-000050f6-3c57c1eb15bab22b2852203dcf8da6e9`.
Yalnız 0022 uygulandı. `dry_run` etkin sürümü:
`c5eede54-71f3-4ed6-a6c1-1756e153da0c`. Sekiz asset değişmedi, beş binding ve
mevcut cron korundu. İlk canlı kontrollerde 46 iş, 447 sonuç ve 0 silme denetimi
vardı. 29 Eylül Türkiye günü için 9 terminal iş bulundu; tam özel dosya raporlarının
tamamlanması ve silme etkinleştirme adımı aşağıdaki kayıtlarla sonuçlandırıldı. Bugünkü 14 + 6 canlı
kabul sonuçları bu önceki gün kapsamına girmez.

Tam canlı dry_run: 9 iş, 108 nesne, 49.380.567 byte; bütün sayfalar tamamlandı,
kapsam dışı anahtar/tarih/şablon 0. Terane 5 × 15, Kurum 3 × 7, Son Halka Arzlar
1 × 12 dosya. Örnek iş kimlikleri: `ce574329-df1d-4ec9-97ac-daefd0867506`,
`cec00508-bd90-4441-8ae2-bf955480aecf`, `39cc8754-adc9-497c-afa4-a291a3855d2f`.
Metin koruma kontrolü: 46 iş, 447 sonuç, 95.626 metin karakteri; dry_run sonunda
silinen dosya 0. Kullanıcı, bu 108 dosyanın kalıcı silinmesini ve aynı dar günlük
temizliği eylem anında ayrıca onayladı. Etkinleştirme ve son temizlik sonucu aşağıda
kayıt edilmiştir; özel dosya anahtarları veya medya URL'leri burada paylaşılmaz.

Günlük temizlik etkin sürümü: `05ff59cb-315e-40bc-a3c5-bbf7b1ea9c10`.
Yalnız `COMMAND_MEDIA_RETENTION_MODE=delete` ile aynı kod yayımlandı; sekiz asset,
beş binding, mevcut read/run ayarları ve cron korundu. Parent, bugünkü kabulün
Kurum metnini ve Terane medya 428'i gerçek MCP üzerinden tekrar başarıyla okudu.
Dört hafta içi zamanlama parent tarafından oluşturuldu: Türkiye 10:30 kesin,
12/16/19 esnek saat aralıkları; bu repo yeni otomasyon oluşturmadı.

## Tamamlanma kanıtı

30 Eylül 10:37 UTC son D1 denetimi: 108/108 dosya `deleted`, 49.380.567 byte;
`pending` veya `error` yok. Dry_run raporu dışından silinen dosya 0; bugünkü
işlerden silinen dosya 0. 46 iş, 447 sonuç ve 95.626 metin karakteri korundu.
Son cron özeti `errors=0`. Parent gerçek MCP ile bugünkü Kurum metnini ve Terane
medya 428'i yeniden okudu. Sıralı canlı kabul ve günlük saklama tamamlandı.

Geçici Cloudflare oturumu resmî `wrangler logout` ile kapandı:
`Successfully logged out`. Sunucu tarafında yalnız Wrangler grant Revoke edildi;
taze Chrome Connected Applications ekranı `No connected applications found` ve
devre dışı Revoke all gösterdi. Geçici login/consent/credential dosyaları kaldırıldı.
Yeni grant, ek OAuth kapsamı, push veya PR yoktur. Asıl checkout temiz bırakıldı.

Teslim: `../heran-command-media-retention.patch`, temiz baz
`3e6de747cb24dd4096547946ad95f1d403ab78c2` karşısında reader + workflow + saklama
birleşik patch'idir; orijinal reader ve workflow patch dosyaları ayrıca korunmuştur.
`git apply --check` asıl temiz checkout üzerinde başarılıdır; oraya uygulanmadı.
