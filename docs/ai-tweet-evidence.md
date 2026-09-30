# Tweet kaynak çözümleme

Telegram ve Mini App aynı `generateTweetDraft` akışını kullanır. Çıktı yalnız hashtagler ve tweet gövdesidir; kaynak etiketi veya bağlantı eklenmez. Kaynaklar doğrulama için içeride tutulur. Taslak oluşturmak X'te yayınlama yapmaz.

## Kaynak hazırlama

KAP'ın yalnız `disclosureScrollableArea` alanı okunur. Gizli İngilizce kopyalar, menüler ve sayfa komutları elenir. Birleşik hücreler özgün koordinatlarıyla korunur; her değer için üst kolon başlıkları ve soldaki satır başlıkları çözülür. KAP'ın TD ile yazdığı açık finansal başlıklar ve iki kolonlu alan/değer formları tanınır. Bölüm başlığı, açık birim/ölçek ve işlem tarihi değere bağlı kalır. Başlıkları belirsiz veya birden fazla kolona yayılmış veri hücresinden sayı alınmaz.

KAP yayıncı adı, sayfanın resmi JSON verisindeki bildirim kimliği URL ile eşleştirilerek alınır. Yayıncı kimliği tek başına bir işlemin gerçekleştiğini veya işlemi o kurumun yaptığını kanıtlamaz. Pay alım/satımı aktörü ayrıca ana metin/tabloyla desteklenmelidir. Hashtagler akışın gerçek bildirim konusu kodlarından seçilir.

`nominal_amount`, `share_count`, `cash_amount`, `unit_price`, `percentage` farklı ölçülerdir. `transaction`, `cumulative`, `prior_cumulative`, `planned`, `holding` ayrı kapsamlardır. Bilinmeyen ölçü veya birim tahmin edilmez. Aynı tarihte birden çok işlem satırı varsa tek satırın miktarı günlük toplam olarak sunulmaz. Ek Açıklamalar'da açık günlük toplam yoksa yeni bir toplam hesaplanmaz.

Metin kapsamı değerin geçtiği kaynak cümlesinden çözülür. “30 Eylül 2026 tarihinde toplam ... pay geri alınmıştır” günlük işlemdir; tek başına “toplam” program birikimi kanıtı değildir. Aynı paragraftaki sonraki sermaye oranı cümlesi günlük miktarın kapsamını değiştirmez. Tarih metadatasında “30 Eylül 2026” ve “30.09.2026” aynı gün olarak karşılaştırılır; başka bir gün kabul edilmez. Sayısal olgu değerleri ve kaynak alıntıları hâlâ birebir korunur.

## İki aşama ve uygulama kontrolleri

1. Luna, yüksek değerlendirme düzeyinde ana olayı, aktörü, işlem yönünü, aşamayı ve en fazla 12 ilgili olguyu strict JSON schema ile çıkarır. Her olgu bir özgün pasaj/hücre kimliğine ve birebir alıntıya bağlıdır. Başlık ve kayıt özeti kanıt sayılmaz.
2. Uygulama alıntının gerçekten o kaynakta olmasını, değerin değişmemesini, nominal/adet/tutar ayrımını, birimi, kapsamı ve hedef işlem tarihini denetler. Eski karar tarihi yeni program kararı için yeterli kanıt değildir.
3. İkinci Luna çağrısı yalnız kabul edilen olgular, bunların özgün kanıtları ve kullanılan eklerle kısa tweet yazar. Önceki çıkarımın anlamını yeniden kontrol eder. Ek kullanıcı talimatı bu aşamada yalnız üslup için uygulanır.
4. Gövdedeki her rakam/tarih bir olguya bağlanır. Uygulama sayıyı, nominal/adet/harcama ifadesini, kapsamı, işlem yönünü ve temel işlem aşaması kurallarını kontrol eder. Bir kontrol geçmezse taslak teslim edilmez ve önbelleğe yazılmaz.

İki model çağrısı toplam 130 saniye bütçe paylaşır; kaynak okuma 25 saniyeyle sınırlıdır. Telegram'ın 180 saniyelik işlem sahiplenmesi içinde kalır. Eksik yanıt veya doğrulama hatası ücretli otomatik tekrar başlatmaz. Normal taslak kaynak digest'i ve prompt sürümüyle önbelleğe alınır; yeniden oluşturma önbelleği atlar. Dosya URL'lerinin içeriği değişebileceği için ekli kaynaklar yeniden okunur.

## İnceleme ve sınırlar

`ai_tweet_drafts.evidence_json`, son normal taslağın olayını, alıntılarını, seçilmiş olgularını ve gövde sayı eşleştirmelerini saklar. API anahtarı veya kullanıcı ek talimatı bu alana yazılmaz. Özelleştirilmiş taslak normal önbelleği değiştirmez.

HTML alıntıları uygulama tarafından birebir karşılaştırılır. PDF/dosya alıntıları için bağımsız yerel metin çıkarımı yapılmaz; ikinci çağrı özgün eki yeniden okur. Şema yalnız çıktı yapısını sınırlar, doğru yorumu garanti etmez. Metinsel iddialar, kısaltılmış şirket isimleri ve karmaşık tablolardaki anlamsal ilişkiler hâlâ model yorumuna bağlıdır. Yayın öncesi editör incelemesi gereklidir.

Dağıtımda `0024_ai_tweet_evidence.sql` D1 migration'ı Worker'dan önce uygulanmalıdır. `editor-v9-daily-scope`, önceki sürümlerin taslaklarını yeniden kullanmaz.
