import { shareActivity } from './share-activity';
export function isImportantPublicDisclosure<T extends {title:string;company:string|null;codes:string[]}>(item: T, priorityCodes: readonly string[] = []): boolean {
  const title = `${item.title} ${item.company ?? ""}`.toLocaleUpperCase("tr-TR");
  const disclosureTitle = item.title.toLocaleUpperCase("tr-TR");
  if (shareActivity(item.title)) return true;
  if (/PORTFÖY DAĞILIM RAPORU|BORSA DIŞI VAAD SÖZLEŞMESİ|BORSA DIŞI REPO\s*-\s*TERS REPO SÖZLEŞMESİ|FONU? SÜREKLİ BİLGİLENDİRME FORMU|KREDİ DERECELENDİRMESİ|YATIRIMCI BİLGİ FORMU/.test(disclosureTitle)) return false;
  if (/TEMERRÜT İŞLEMİ/.test(disclosureTitle) && !/FON|PORTFÖY|TEFAS/.test(title)) return false;
  if (disclosureTitle.includes("PAY DIŞINDA SERMAYE PİYASASI ARACI İŞLEMLERİNE İLİŞKİN BİLDİRİM (FAİZ İÇEREN)") ||
      disclosureTitle.includes("RİSK ÖLÇÜM VE DEĞERLEME ESASLARI")) return false;
  if (disclosureTitle.includes("PAY DIŞINDA SERMAYE PİYASASI ARACI İŞLEMLERİNE İLİŞKİN BİLDİRİM (FAİZSİZ)") ||
      /KURUMSAL YÖNETİM BİLGİ FORMU\s*\(GÜNCELLEME\)\s*-\s*YÖNETİM KURULU-2/.test(disclosureTitle)) return false;
  if (!item.codes.length) return /FON|PORTFÖY|VARLIK YÖNETİM/.test(title);
  if (/ŞİRKET GENEL BİLGİ FORMU|HAK KULLANIM SÜREÇ DURUMU/.test(title)) return false;
  return true;
}
