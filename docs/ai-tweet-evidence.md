# Tweet üretim akışı

Telegram ve Mini App aynı `generateTweetDraft` akışını kullanır. `editor-v18-direct-draft`, kullanıcının inceleyip düzenleyeceği taslağı tek model çağrısıyla üretir. X üzerinde otomatik paylaşım yapılmaz.

## Kaynak

Haberin başlığı ve ana metni, KAP bildiriminin tam içeriği, tabloların satır/sütun bağlamı ve ilgili dosya ekleri modele birlikte gönderilir. Menü, reklam ve ilgisiz haberler ayıklanır. Resmî KAP yayıncı kimliği de metne eklenir; yayıncı her zaman işlemi yapan taraf değildir. PDF ekleri aynı istekte modele verilir. X paylaşımı kaynak hesaba atfedilir.

## Tek aşamalı taslak

`gpt-6-luna`, medium değerlendirme ve 8000 çıktı tokenı üst sınırıyla yalnız `status` ve `body` döndürür. İstek 100 saniyeyle sınırlıdır. Ayrı kaynak çözümlemesi, olgu listesi, alıntı eşleştirmesi, rakam/işlem doğrulama kapısı veya ücretli otomatik onarım çağrısı çalışmaz. Eski `evidence.ts` yardımcıları tweet üretim yolunda kullanılmaz.

Kaynağa sadakat, doğru özne, alış/satış yönü, nominal/adet ayrımı, tarih, program toplamı ve gerçekleşme aşaması promptta anlatılır. Belirsiz ikincil ayrıntı çıkarılarak ana haber anlatılabilir. Başlık hafifçe yeniden yazılır; X Premium için 280 karakter hedefi yoktur. Kaynak dışı bilgi, abartı ve tekrar istenmez. Teknik gövde sınırı 3200 karakterdir.

Ek talimat sistem promptuna eklenir; önceki taslak ve tercih modele iletilir. Kullanıcının uzunluk, başlık ve vurgu tercihleri varsayılan yazım düzeninden önceliklidir. Uygulama dönen metni sayısal anlam kurallarıyla reddetmez.

## Hata ve önbellek

Okunamayan kaynak, bağlantı/API hatası, tamamlanmamış yanıt ve boş çıktı hata olarak kalır. Başlıktan veya eski özetten kaynak uydurulmaz; yarım yanıt gösterilmez. Çıktı biçimi ve teknik uzunluk kontrolü korunur.

Normal taslak kaynak digest'i ve prompt sürümüyle önbelleğe alınır. Yeniden oluşturma ve ek talimat önbelleği atlar. Ekli kaynakların içeriği URL sabitken değişebileceğinden bunlar yeniden okunur. Özelleştirilmiş taslak normal önbelleği değiştirmez. `evidence_json` artık yalnız sürüm, doğrudan üretim modu ve kaynak türünü saklar. Önceki kayıtlar ve migration dosyaları korunur; bu değişiklik için yeni migration gerekmez.
