// Source coordinates belong to the application, not the model. Keep the raw
// cells alongside their resolved headings so uncertain tables remain visible.
export type Metric = 'nominal_amount' | 'share_count' | 'cash_amount' | 'unit_price' | 'percentage' | 'date' | 'text' | 'unknown';
export type Scope = 'transaction' | 'cumulative' | 'prior_cumulative' | 'planned' | 'holding' | 'unknown';
export interface SourcePassage { id: string; text: string; section: string; }
export interface RawCell { text: string; header: boolean; rowSpan: number; colSpan: number; }
export interface SourceCell {
  id: string; row: number; column: number; text: string;
  columnHeaders: string[]; rowHeaders: string[]; section: string;
  metric: Metric; scope: Scope; unit: string | null;
  transactionDate: string | null; ambiguous: boolean;
  transactionRowsOnDate: number | null;
}
export interface SourceTable {
  id: string; section: string; caption: string; unitContext: string;
  rows: RawCell[][]; cells: SourceCell[];
}
export interface SourceDocument { version: 1; passages: SourcePassage[]; tables: SourceTable[]; }
export const normalizeLabel = (value: string) => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i').replace(/\s+/g,' ').trim();
const clean = (value: string) => value.replace(/\s+/g,' ').trim();

export function metricFor(label: string): Metric {
  const text = normalizeLabel(label);
  if (/nominal/.test(text)) return 'nominal_amount';
  if (/fiyat|\/(?:adet|pay)|birim deger/.test(text)) return 'unit_price';
  if (/oran|yuzde|%/.test(text)) return 'percentage';
  if (/tarih/.test(text)) return 'date';
  if (/(?:pay|lot).{0,25}(?:adet|adedi|sayisi)|adet|adedi|lot sayisi/.test(text)) return 'share_count';
  if (/tutar|fon|bedel|maliyet|hasilat|\bkar[ıi]?\b|zarar|gelir|nakit|varlik|yukumluluk|ozkaynak/.test(text)) return 'cash_amount';
  return 'unknown';
}

export function scopeFor(label: string, section: string): Scope {
  const text = normalizeLabel(label), context = normalizeLabel(section);
  if (/daha once|islem oncesi|onceki|once geri/.test(text)) return 'prior_cumulative';
  if (/toplam|kumulatif|program kapsaminda.*ulas|bugune kadar/.test(text) && !/ayrilan|azami|planlanan/.test(text)) return 'cumulative';
  if (/azami|ayrilan fon|planlanan|hedeflenen/.test(text) || /planlanan donem/.test(context)) return 'planned';
  if (/sahip olunan|sahip olunan pay|bakiye|mevcut pay/.test(text)) return 'holding';
  if (/isleme konu paylar|islem (?:tarihi|fiyati|tutari)|alinan pay|satilan pay/.test(text) || /islemlerinin detay|alim satim islemleri/.test(context)) return 'transaction';
  return 'unknown';
}

// A prose sentence can give a daily total. The word "toplam" by itself
// establishes no period, unlike an explicit cumulative table heading.
export function proseScopeFor(quote: string, value: string): Scope {
  const text = normalizeLabel(quote), needle = normalizeLabel(value);
  const sentences = text.split(/(?<=[.!?])\s+/).filter(sentence => sentence.includes(needle));
  const scopes = sentences.map(sentence => {
    if (/daha once|islem oncesi|onceki|once geri/.test(sentence)) return 'prior_cumulative';
    if (/azami|ayrilan fon|planlanan|hedeflenen/.test(sentence)) return 'planned';
    if (/kumulatif|bugune kadar|baslangicindan|program toplami|program(?:i)? (?:kapsaminda|cercevesinde) toplam/.test(sentence)) return 'cumulative';
    const datedDay = /(?:\d{1,2}[./]\d{1,2}[./]\d{4}|\d{1,2} \p{L}+ \d{4}) (?:tarihinde|gunu)/u.test(sentence);
    if ((datedDay || /gun icinde|gunluk|bu islemde/.test(sentence)) && /geri al|satin al|satil|satim|alim/.test(sentence)) return 'transaction';
    // "itibarıyla ... toplam ... ulaşmıştır" is a balance, even when a
    // calendar date appears in that same sentence.
    if (/toplam|ulas/.test(sentence)) return /toplam.*ulas|itibariyla.*toplam/.test(sentence) ? 'cumulative' : 'unknown';
    return scopeFor(sentence, '');
  });
  const known = [...new Set(scopes.filter(scope => scope !== 'unknown'))];
  return known.length === 1 ? known[0] as Scope : 'unknown';
}

function unitFor(label: string, context: string): string | null {
  // Column labels override a table-level scale. Never infer a currency from
  // the company's domicile, or turn nominal TL into an adet/lot unit.
  const explicit = (value: string) => value.match(/(?:milyon|milyar|bin)\s*(?:TL|TRY|USD|EUR|ABD Doları|Avro|Euro)|(?:TL|TRY|USD|EUR|₺|\$|€)\s*\/\s*(?:Adet|Pay)|\b(?:TL|TRY|USD|EUR|Adet|Lot|Avro|Euro|ABD Doları)\b|[%₺$€]/i)?.[0] ?? null;
  const own=explicit(label), shared=explicit(context),metric=metricFor(label);
  if(metric==='date')return null;
  if(metric==='percentage')return own==='%'?own:null;
  if(metric==='share_count')return own??(/lot/i.test(label)?'lot':'adet');
  if (own && shared && /^(?:bin|milyon|milyar)\b/i.test(shared) && shared.toLocaleLowerCase('tr-TR').endsWith(own.toLocaleLowerCase('tr-TR'))) return shared;
  return own ?? shared;
}

interface Positioned { raw: RawCell; row: number; column: number; }
const looksLikeHeading = (value: string) => /tarih|nominal|fiyat|tutar|oran|isleme konu|pay grubu|islem turu|al[ıi]m|sat[ıi]m|adet|unvan|sermaye|dönem|donem/.test(normalizeLabel(value));

export function sourceTable(el: Element, id: string, section: string, unitContext: string): SourceTable {
  const span = (cell: Element, name: string) => {
    const value=Number(cell.getAttribute(name) ?? '1');
    if (!Number.isSafeInteger(value) || value<1 || value>200) throw new Error('Tablonun birleşik hücre yapısı güvenle ayrıştırılamadı');
    return value;
  };
  const rows: RawCell[][] = [...el.querySelectorAll('tr')].map(row => [...row.children].filter(cell=>/^(TD|TH)$/.test(cell.tagName)).map(cell=>({text:clean(cell.textContent??''),header:cell.tagName==='TH',rowSpan:span(cell,'rowspan'),colSpan:span(cell,'colspan')})));
  if (rows.length>1000) throw new Error('Kaynak tablosu güvenli satır sınırını aşıyor');
  const grid: Positioned[][]=[], anchors: Positioned[]=[];
  rows.forEach((row,r)=>{
    grid[r]??=[];
    let c=0;
    for (const raw of row) {
      while(grid[r][c])c++;
      if (c+raw.colSpan>100 || r+raw.rowSpan>rows.length) throw new Error('Tablonun hücre koordinatları belirsiz');
      const cell={raw,row:r,column:c}; anchors.push(cell);
      for(let rr=r;rr<r+raw.rowSpan;rr++) {
        grid[rr]??=[];
        for(let cc=c;cc<c+raw.colSpan;cc++) {
          if (grid[rr][cc]) throw new Error('Tabloda çakışan birleşik hücreler var');
          grid[rr][cc]=cell;
        }
      }
      c+=raw.colSpan;
    }
  });
  const width=Math.max(0,...grid.map(row=>row.length));
  // KAP uses TD for column headings. Require several explicit financial
  // labels; arbitrary prose and field/value forms must not become headings.
  let headerRows=0;
  for(const row of rows.slice(0,8)) {
    const nonempty=row.filter(cell=>cell.text);
    const explicit=nonempty.length>0 && nonempty.every(cell=>cell.header);
    const inferred=row.length>=3 && row.filter(cell=>looksLikeHeading(cell.text)).length>=2 && row.every(cell=>!/^[-+%\d]/.test(cell.text));
    const years=headerRows>0 && rows[headerRows-1].some(cell=>cell.colSpan>1) && nonempty.length>0 && nonempty.every(cell=>/^(?:19|20)\d{2}$/.test(cell.text));
    if (!explicit && !inferred && !years) break;
    headerRows++;
  }
  const fields=headerRows===0 && rows.every(row=>row.length===2 && row.every(cell=>cell.rowSpan===1 && cell.colSpan===1));
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
  const cells: SourceCell[]=[];
  for(const cell of anchors) {
    const {row:r,column:c,raw}=cell;
    if(r<headerRows || !raw.text)continue;
    const columnHeaders=fields ? [rows[r][0].text] : unique(Array.from({length:headerRows},(_,h)=>grid[h]?.[c]?.raw.text??''));
    // Row labels are text cells to the left, including inherited rowspan
    // labels. Values such as a previous amount are not row headings.
    const rowHeaders=fields ? [] : unique((grid[r]??[]).slice(0,c).filter(other=>other!==cell && (other.raw.header || (!/^[([]?[-+%]?\s*\d/.test(other.raw.text) && !/^\d{2}[./]\d{2}[./]\d{4}$/.test(other.raw.text)))).map(other=>other.raw.text));
    if(fields && c===0)continue;
    const label=columnHeaders.join(' / ');
    const rowLabel=rowHeaders.join(' / '),metric=metricFor(label)==='unknown'?metricFor(rowLabel):metricFor(label);
    const scope=scopeFor(label,section)==='unknown'?scopeFor(rowLabel,section):scopeFor(label,section);
    const dateColumn=headerRows ? grid[0].findIndex((_,col)=>Array.from({length:headerRows},(_,h)=>normalizeLabel(grid[h]?.[col]?.raw.text??'')).some(text=>/^(?:islem|alim|satim) tarihi$/.test(text))) : -1;
    const date=dateColumn>=0?grid[r]?.[dateColumn]?.raw.text??null:null;
    cells.push({id:`${id}:r${r+1}:c${c+1}`,row:r+1,column:c+1,text:raw.text,columnHeaders,rowHeaders,section,metric,scope,unit:unitFor(metricFor(label)==='unknown'?`${rowLabel} / ${label}`:label,unitContext),transactionDate:date,transactionRowsOnDate:null,
      ambiguous:!fields && (!headerRows || raw.colSpan>1 || grid[r].length!==width || Array.from({length:width},(_,cc)=>!grid[r][cc]).some(Boolean))});
  }
  const dates=new Map<string,Set<number>>();
  for(const cell of cells)if(cell.transactionDate) {if(!dates.has(cell.transactionDate))dates.set(cell.transactionDate,new Set());dates.get(cell.transactionDate)!.add(cell.row);}
  for(const cell of cells)if(cell.transactionDate)cell.transactionRowsOnDate=dates.get(cell.transactionDate)!.size;
  return {id,section,caption:clean(el.querySelector('caption')?.textContent??''),unitContext,rows,cells};
}

export function plainDocument(text: string): SourceDocument {
  return {version:1,passages:[{id:'p1',text,section:''}],tables:[]};
}
