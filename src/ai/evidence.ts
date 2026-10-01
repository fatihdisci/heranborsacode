import { normalizeLabel, proseScopeFor, type Metric, type Scope, type SourceCell, type SourceDocument } from './source-document';
import { shareActivity } from '../kap/share-activity';

export interface EvidenceRef { sourceId: string; quote: string; location: string | null; }
export interface VerifiedFact {
  id: string; meaning: string; value: string; metric: Metric; scope: Scope;
  unit: string | null; transactionDate: string | null; evidence: EvidenceRef[];
  // Application-derived context, never accepted from the model as authority.
  transactionRowsOnDate?: number;
}
export interface VerifiedEvent {
  kind: 'buyback_transaction' | 'buyback_decision' | 'buyback_completion' | 'ownership_transaction' | 'other';
  stage: 'executed' | 'decision' | 'proposal' | 'application' | 'approval' | 'expectation' | 'other';
  actor: string | null; subject: string | null; summary: string; eventDate: string | null; evidence: EvidenceRef[];
  direction: 'buy' | 'sell' | 'mixed' | 'none';
}
export interface SourceAnalysis { status: 'ready' | 'insufficient' | 'conflict'; event: VerifiedEvent; facts: VerifiedFact[]; ambiguities: string[]; }
export interface WrittenDraft { status: 'ready' | 'reject'; body: string; usedFactIds: string[]; numericClaims: Array<{text:string; factId:string}>; }
interface Entry { id: string; text: string; section: string; cell?: SourceCell; }
const METRICS: Metric[]=['nominal_amount','share_count','cash_amount','unit_price','percentage','date','duration','text','unknown'];
const FINANCIAL_METRICS:Metric[]=['nominal_amount','share_count','cash_amount','unit_price','percentage'];
const SCOPES: Scope[]=['transaction','cumulative','prior_cumulative','planned','holding','unknown'];
const KINDS=['buyback_transaction','buyback_decision','buyback_completion','ownership_transaction','other'];
const STAGES=['executed','decision','proposal','application','approval','expectation','other'];
const DIRECTIONS=['buy','sell','mixed','none'];
const string={type:'string'};
const nullableString={type:['string','null']};
const object=(properties:Record<string,unknown>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items:unknown)=>({type:'array',items});
const evidenceSchema=array(object({sourceId:string,quote:string,location:nullableString}));
export const ANALYSIS_SCHEMA=object({
  status:{type:'string',enum:['ready','insufficient','conflict']},
  event:object({kind:{type:'string',enum:KINDS},stage:{type:'string',enum:STAGES},direction:{type:'string',enum:DIRECTIONS},actor:nullableString,subject:nullableString,summary:string,eventDate:nullableString,evidence:evidenceSchema}),
  facts:array(object({id:string,meaning:string,value:string,metric:{type:'string',enum:METRICS},scope:{type:'string',enum:SCOPES},unit:nullableString,transactionDate:nullableString,evidence:evidenceSchema})),
  ambiguities:array(string),
});
export const DRAFT_SCHEMA=object({status:{type:'string',enum:['ready','reject']},body:string,usedFactIds:array(string),numericClaims:array(object({text:string,factId:string}))});
export class SourceValidationError extends Error {
  context?: {phase?:'source_analysis'|'tweet_writer';factId?:string;metric?:Metric;scope?:Scope};
  constructor(reason:string) {super(`Kaynak doğrulaması başarısız: ${reason}`);this.name='SourceValidationError';}
}
const fail=(reason:string):never=>{throw new SourceValidationError(reason);};
const normalized=(value:string)=>value.replace(/\s+/g,' ').trim();
const numbers=(value:string)=>[...value.matchAll(/[+−-]\s*\d+(?:[.,/]\d+)*|\d+(?:[.,/]\d+)*/g)].map(match=>({value:match[0].replace(/\s/g,'').replace(/−/g,'-'),start:match.index!,end:match.index!+match[0].length}));
const text=(value:unknown,max=2000):value is string=>typeof value==='string' && value.trim().length>0 && value.length<=max;
const nullable=(value:unknown):value is string|null=>value===null || text(value);

// Legal names may differ only in punctuation (A.Ş. / AŞ). Keep every
// substantive word, and compare complete tokens rather than substrings.
function partyName(value:string):string {
  return normalizeLabel(value).replace(/[^\p{L}\p{N}]+/gu,' ').trim()
    .replace(/\ba\s+s\b|\bas\b/g,'anonim sirketi');
}
function partyIn(name:string,source:string):boolean {
  return (` ${partyName(source)} `).includes(` ${partyName(name)} `);
}

function includeIssuerIdentity(event:VerifiedEvent,registry:Map<string,Entry>):void {
  const issuer=registry.get('kap-issuer');
  // An issuer alone does not prove an event or the actor of a shareholder
  // trade. Resolve first-person disclosure prose only, retaining its event
  // evidence independently of the official identity reference.
  if(!issuer || event.kind==='ownership_transaction' || !event.evidence.some(ref=>
    ref.sourceId!=='kap-issuer' && registry.has(ref.sourceId) &&
    /\b(?:sirketimiz|ortakligimiz)\b/.test(normalizeLabel(ref.quote))))return;
  const identity=partyName(issuer.text);
  const matches=[event.actor,event.subject].some(name=>{
    if(!name)return false;
    const key=partyName(name);
    return key===identity || (key.length>=3 && identity.startsWith(`${key} `));
  });
  if(matches && !event.evidence.some(ref=>ref.sourceId==='kap-issuer')) {
    event.evidence.push({sourceId:'kap-issuer',quote:issuer.text,location:null});
  }
}

function entries(document:SourceDocument|null):Map<string,Entry> {
  const result=new Map<string,Entry>();
  for(const passage of document?.passages??[])result.set(passage.id,passage);
  for(const table of document?.tables??[])for(const cell of table.cells)result.set(cell.id,{id:cell.id,text:cell.text,section:cell.section,cell});
  return result;
}

function refs(value:unknown,registry:Map<string,Entry>,attachments:Set<string>):EvidenceRef[] {
  const list=Array.isArray(value)?value:fail('kanıt referansları eksik');
  if(!list.length || list.length>12)fail('kanıt referansları eksik');
  for(const ref of list) {
    if(!ref || !text(ref.sourceId,80) || !text(ref.quote,4000) || !nullable(ref.location))fail('kanıt biçimi hatalı');
    const entry=registry.get(ref.sourceId);
    if(entry) {
      if(!normalized(entry.text).includes(normalized(ref.quote)))fail('alıntı kaynak pasajı veya hücresiyle eşleşmiyor');
      if(!numbers(ref.quote).every(number=>numbers(entry.text).some(raw=>raw.value===number.value)))fail('alıntıda sayı veya tarihin bir bölümü kesildi');
    } else if(!attachments.has(ref.sourceId) || !text(ref.location,1000))fail('bilinmeyen kaynak veya konumsuz ek alıntısı');
  }
  return list as EvidenceRef[];
}

function dateKey(value:string):string|null {
  const months=['ocak','subat','mart','nisan','mayis','haziran','temmuz','agustos','eylul','ekim','kasim','aralik'];
  const literal=normalizeLabel(value);
  let match=literal.match(/^(\d{2})[./](\d{2})[./](\d{4})$/);
  let key=match?`${match[3]}-${match[2]}-${match[1]}`:null;
  if(!key && /^\d{4}-\d{2}-\d{2}$/.test(literal))key=literal;
  if(!key) {
    match=literal.match(/^(\d{1,2})\s+(\p{L}+)\s+(\d{4})$/u);
    if(match && months.includes(match[2]))key=`${match[3]}-${String(months.indexOf(match[2])+1).padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  }
  if(!key)return null;
  const stamp=Date.parse(`${key}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10)===key?key:null;
}

function datesInText(value:string):string[] {
  return [...value.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{4}\b|\b\d{1,2}\s+\p{L}+\s+\d{4}\b/gu)].map(match=>match[0]).filter(date=>dateKey(date)!==null);
}

function containsDate(value:string,date:string):boolean {
  const key=dateKey(date);
  return key!==null && datesInText(value).some(candidate=>dateKey(candidate)===key);
}

function contexts(evidence:EvidenceRef[],registry:Map<string,Entry>):string {
  return evidence.map(ref=>{
    const entry=registry.get(ref.sourceId),cell=entry?.cell;
    return [ref.quote,entry?.section,...(cell?.columnHeaders??[]),...(cell?.rowHeaders??[])].filter(Boolean).join(' / ');
  }).join('\n');
}

function explicitlyCounted(quote:string,value:string):boolean {
  const source=normalizeLabel(quote),needle=normalizeLabel(value);
  // An explicit "5.000.000 adet" remains a count when that sentence also
  // states the nominal TL value. A nominal-only amount is never a count.
  for(let index=source.indexOf(needle);index>=0;index=source.indexOf(needle,index+1)) {
    const rest=source.slice(index+needle.length);
    if (/^(?:\s*(?:adet|lot|pay)\b)/.test(rest) || /\b(?:adet|lot|pay)$/.test(needle))return true;
  }
  return false;
}

function explicitlyCash(quote:string,value:string):boolean {
  const source=normalizeLabel(quote),needle=normalizeLabel(value);
  for(let index=source.indexOf(needle);index>=0;index=source.indexOf(needle,index+1)) {
    const after=source.slice(index+needle.length).split(/\d/)[0];
    const before=source.slice(0,index).split(/\d/).at(-1)??'';
    if (/^\s*(?:tl|try|usd|eur|avro|euro|dolar)\b/.test(after) && !/nominal/.test(after)
      && (/karsiliginda|bedelle|harcan|oden/.test(after) || /odenen|harcanan|maliyet|islem tutari|islem bedeli|ayrilan fon/.test(before)))return true;
  }
  return false;
}

export function validateAnalysis(value:unknown,document:SourceDocument|null,attachmentIds:string[],title:string):SourceAnalysis {
  const analysis=value as SourceAnalysis;
  if(!analysis || !['ready','insufficient','conflict'].includes(analysis.status))fail('çözümleme biçimi hatalı');
  if(analysis.status!=='ready')throw new Error('Kaynak tweet oluşturmak için yeterli değil veya çelişkili');
  const registry=entries(document),attachments=new Set(attachmentIds),event=analysis.event;
  if(!event || !KINDS.includes(event.kind) || !STAGES.includes(event.stage) || !DIRECTIONS.includes(event.direction) || !nullable(event.actor) || !nullable(event.subject) || !nullable(event.eventDate) || !text(event.summary))fail('ana olay eksik');
  event.evidence=refs(event.evidence,registry,attachments);
  if(!event.evidence.some(ref=>ref.sourceId!=='kap-issuer'))fail('yalnız yayıncı kimliğinden olay çıkarıldı');
  includeIssuerIdentity(event,registry);
  if(!Array.isArray(analysis.facts) || analysis.facts.length>12 || !Array.isArray(analysis.ambiguities) || analysis.ambiguities.length>20 || !analysis.ambiguities.every(v=>typeof v==='string' && v.length<=2000))fail('olgu listesi hatalı');
  const allRefs=[...event.evidence];
  analysis.facts.forEach((fact,i)=>{
    if(!fact || fact.id!==`f${i+1}` || !text(fact.meaning,1000) || !text(fact.value) || !METRICS.includes(fact.metric) || !SCOPES.includes(fact.scope) || !nullable(fact.unit) || !nullable(fact.transactionDate))fail('olgu biçimi hatalı');
    fact.evidence=refs(fact.evidence,registry,attachments);allRefs.push(...fact.evidence);
    // Restore the source spelling only for an equivalent, complete calendar
    // date. Amounts, quantities and percentages are never normalised this way.
    if(fact.metric==='date' && dateKey(fact.value)) {
      const sourceDate=fact.evidence.flatMap(ref=>datesInText(ref.quote)).find(date=>dateKey(date)===dateKey(fact.value));
      if(sourceDate)fact.value=sourceDate;
    }
    if(fact.metric==='duration') {
      const pattern=new RegExp(normalized(fact.value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu');
      const sourceDuration=fact.evidence.map(ref=>normalized(ref.quote).match(pattern)?.[0]).find(Boolean);
      if(sourceDuration)fact.value=sourceDuration;
    }
    if(!fact.evidence.some(ref=>normalized(ref.quote).includes(normalized(fact.value))))fail('olgu değeri kendi alıntısında yok');
    const matching=fact.evidence.filter(ref=>normalized(ref.quote).includes(normalized(fact.value)));
    if(!numbers(fact.value).every(number=>matching.some(ref=>numbers(ref.quote).some(raw=>raw.value===number.value))))fail('olgu değeri alıntıdaki sayıdan farklı');
    if(fact.metric==='cash_amount' && !fact.value.trim().startsWith('(') && matching.some(ref=>normalized(ref.quote).replace(/\(\s+/g,'(').replace(/\s+\)/g,')').includes(`(${normalized(fact.value)})`)))fail('parantezle belirtilen tutarın işareti kayboldu');
    delete fact.transactionRowsOnDate;
    for(const ref of matching) {
      const cell=registry.get(ref.sourceId)?.cell;
      if(!cell)continue;
      if(numbers(fact.value).length && cell.ambiguous)fail('sayının tablo başlığı belirsiz');
      if(numbers(fact.value).length && normalized(fact.value)!==normalized(cell.text))fail('tablo değeri değiştirildi');
      if(cell.metric!=='unknown' && fact.metric!==cell.metric)fail('nominal/adet/fiyat/tutar etiketi değiştirildi');
      if(cell.scope!=='unknown' && fact.scope!==cell.scope)fail('işlem/toplam/önceki toplam/plan kapsamı değiştirildi');
      if(normalizeLabel(fact.unit??'')!==normalizeLabel(cell.unit??''))fail('tablo birimi veya ölçeği değiştirildi');
      if(cell.transactionDate && (!fact.transactionDate || dateKey(fact.transactionDate)!==dateKey(cell.transactionDate)))fail('tablo değeri başka işlem gününe bağlandı');
      if(cell.transactionDate)fact.transactionDate=cell.transactionDate;
      if(fact.transactionDate && !cell.transactionDate)fail('tarihsiz tablo değeri işlem gününe bağlandı');
      if(cell.transactionDate) {
        if(!event.eventDate || !dateKey(event.eventDate) || dateKey(event.eventDate)!==dateKey(cell.transactionDate))fail('geçmiş tablonun satırı hedef işlem günüyle karıştı');
        fact.transactionRowsOnDate=Math.max(fact.transactionRowsOnDate??0,cell.transactionRowsOnDate??0);
      }
    }
    const context=normalizeLabel(contexts(matching,registry));
    if(numbers(fact.value).length && [...FINANCIAL_METRICS,'duration'].includes(fact.metric) && !fact.unit)fail('sayısal finansal değerin birimi belirsiz');
    if(numbers(fact.value).length && ['nominal_amount','share_count','cash_amount','unit_price'].includes(fact.metric) && matching.every(ref=>!registry.get(ref.sourceId)?.cell)) {
      const scale=context.match(/\b(?:bin|milyon|milyar)\b/)?.[0];
      if(scale && !normalizeLabel(`${fact.value} ${fact.unit??''}`).includes(scale))fail('alıntıdaki bin/milyon/milyar ölçeği kayboldu');
    }
    if(fact.transactionDate && !fact.evidence.some(ref=>containsDate(ref.quote,fact.transactionDate!) || registry.get(ref.sourceId)?.cell?.transactionDate===fact.transactionDate))fail('olgunun işlem tarihi kanıtında yok');
    if(fact.scope==='transaction' && fact.transactionDate && event.eventDate && dateKey(fact.transactionDate)!==dateKey(event.eventDate))fail('metin olgusu başka işlem gününe bağlandı');
    if(fact.metric==='nominal_amount' && !context.includes('nominal'))fail('nominal değer kanıtı yok');
    if((fact.metric==='share_count' || fact.metric==='cash_amount') && matching.every(ref=>!registry.get(ref.sourceId)?.cell) && context.includes('nominal')
      && !matching.some(ref=>fact.metric==='share_count'?explicitlyCounted(ref.quote,fact.value):explicitlyCash(ref.quote,fact.value)))fail('nominal tutar adet veya işlem tutarına dönüştürüldü');
    if(fact.unit && matching.every(ref=>!registry.get(ref.sourceId)?.cell) && !context.includes(normalizeLabel(fact.unit)))fail('alıntıda birim yok');
    // Labels in prose are useful only when explicit. Do not infer a scope
    // from publication time or from a neighbouring historical table row.
    if(FINANCIAL_METRICS.includes(fact.metric) && numbers(fact.value).length && matching.every(ref=>!registry.get(ref.sourceId)?.cell)) {
      for(const ref of matching) {
        const explicit=proseScopeFor(registry.get(ref.sourceId)?.text??ref.quote,fact.value);
        if(explicit!=='unknown' && fact.scope!==explicit)fail('alıntıdaki kapsam değiştirildi');
      }
    }
  });
  const evidenceText=contexts(allRefs,registry),eventText=normalizeLabel(contexts(event.evidence,registry));
  for(const actor of [event.actor,event.subject])if(actor && !partyIn(actor,evidenceText))fail('işlemin tarafı kaynakta yok');
  // Date spelling is metadata, not a different amount: 30 Eylül 2026 and
  // 30.09.2026 name the same day. All other numbers still match exactly.
  let summaryNumbers=event.summary;
  for(const date of datesInText(event.summary)) {
    if(!allRefs.some(ref=>containsDate(ref.quote,date)))fail('ana olaydaki tarih kaynakta yok');
    summaryNumbers=summaryNumbers.replace(date,'');
  }
  for(const number of numbers(summaryNumbers))if(!allRefs.some(ref=>numbers(ref.quote).some(raw=>raw.value===number.value)))fail('ana olaydaki sayı kaynakta yok');
  if(event.eventDate && !allRefs.some(ref=>containsDate(ref.quote,event.eventDate!)))fail('olay tarihi kaynakta yok');
  const activity=shareActivity(title);
  if(activity==='ownership' && event.kind!=='ownership_transaction')fail('pay alım/satımı geri alım gibi çözümlendi');
  if(activity==='buyback' && !event.kind.startsWith('buyback_'))fail('geri alım olay türü doğrulanamadı');
  if(event.kind==='ownership_transaction' && (!event.actor || event.direction==='none'))fail('pay alım/satımının tarafı veya yönü belirsiz');
  if(event.kind==='ownership_transaction' && event.actor && !allRefs.some(ref=>ref.sourceId!=='kap-issuer' && partyIn(event.actor!,ref.quote)))fail('bildirim yayıncısı işlemi yapan taraf olarak varsayıldı');
  if(event.kind==='buyback_transaction' && event.stage!=='executed')fail('geri alım işlemi gerçekleşme olarak doğrulanmadı');
  if(event.kind==='buyback_transaction' && event.direction==='none')fail('geri alım/satım işlem yönü belirsiz');
  if(event.kind==='buyback_transaction') {
    const tableExecution=event.evidence.some(ref=>{
      const cell=registry.get(ref.sourceId)?.cell;
      return cell && cell.scope==='transaction' && !!cell.transactionDate && !cell.ambiguous;
    });
    if(!tableExecution && !executedPurchase.test(eventText)
      && !/alim.{0,120}(?:yapildi|yapilmistir|gerceklestirildi|gerceklestirilmistir)\b/.test(eventText)
      && !event.evidence.some(ref=>attachments.has(ref.sourceId)))fail('fiili geri alım kanıtı yok');
  }
  if(event.kind==='buyback_decision') {
    // A date labelled "Yönetim Kurulu Karar Tarihi" appears in every trade
    // update too. It cannot, by itself, prove a newly announced decision.
    const decisionRefs=event.evidence.filter(ref=>!registry.get(ref.sourceId)?.cell?.columnHeaders.some(label=>normalizeLabel(label).includes('yonetim kurulu karar tarihi')));
    if(!/baslat|karar|onay|uzat/.test(normalizeLabel(contexts(decisionRefs,registry))) && !decisionRefs.some(ref=>attachments.has(ref.sourceId)))fail('yeni program kararı kanıtı yok');
    const summaries=[...registry.values()].filter(entry=>entry.cell?.columnHeaders.some(label=>normalizeLabel(label)==='ozet bilgi')).map(entry=>normalizeLabel(entry.text)).join(' ');
    if(/islem|geri alindi|alim yap/.test(summaries) && !/baslat|karar|onay|uzat/.test(summaries))fail('işlem bildiriminin eski kararı yeni karar gibi çözümlendi');
  }
  if(event.kind==='buyback_completion' && !/sonlandir|sona er|iptal|tamamlan/.test(eventText) && !event.evidence.some(ref=>attachments.has(ref.sourceId)))fail('programın sona ermesi kanıtı yok');
  return analysis;
}

export function supportingEvidence(analysis:SourceAnalysis,document:SourceDocument|null):Entry[] {
  const registry=entries(document);
  const ids=new Set([...analysis.event.evidence,...analysis.facts.flatMap(fact=>fact.evidence)].map(ref=>ref.sourceId));
  return [...ids].flatMap(id=>registry.has(id)?[registry.get(id)!]:[]);
}

function claimSentence(body:string,start:number,end:number):string {
  const boundaries=[...body.matchAll(/[.!?;]\s+/g)].map(match=>match.index!+match[0].length);
  const left=boundaries.filter(index=>index<=start).at(-1)??0;
  const right=boundaries.find(index=>index>=end)??body.length;
  return body.slice(left,right);
}

const executedPurchase=/(?:geri|satin) al(?:di|dik|indi|inmistir|mistir)(?:gini|gine|ginden)?\b/;
const executedPayment=/\b(?:harcadi|harcandi|harcanmistir|harcamistir|odedi|odendi|odenmistir)(?:gini|gine|ginden)?\b/;

function validateNumericMeaning(claim:string,fact:VerifiedFact,shareEvent:boolean,sentence=claim):void {
  const normalized=normalizeLabel(claim);
  if([...FINANCIAL_METRICS,'date','duration'].includes(fact.metric) && !normalized.includes(normalizeLabel(fact.value)))fail('sayısal değerin yazımı, işareti veya aralığı değiştirildi');
  if(fact.metric==='nominal_amount' && (!normalized.includes('nominal') || /\badet\b|\blot\b|harca|maliyet|odenen|bedelle/.test(normalized)))fail('tweet nominal tutarı adet veya harcama gibi anlatıyor');
  if(fact.metric==='share_count' && (!/\bpay\b|\badet\b|\blot\b/.test(normalized) || /nominal/.test(normalized)))fail('tweet pay adedinin birimini değiştirdi');
  if(fact.metric==='cash_amount' && /nominal|\badet\b|\blot\b/.test(normalized))fail('işlem tutarı nominal değer veya adet gibi anlatılıyor');
  if(fact.metric==='unit_price' && !/fiyat|ortalama|\/(?:adet|pay)|(?:TL|TRY|USD|EUR|avro|euro|dolar)[’']?den/i.test(claim))fail('birim fiyat toplam işlem tutarı gibi anlatılıyor');
  if(fact.metric==='percentage' && !/%|yuzde/.test(normalized))fail('yüzde birimi kayboldu');
  if(['date','duration','text','unknown'].includes(fact.metric) && /\bTL\b|\bUSD\b|\bEUR\b|₺|\$|€|nominal|\badet\b|\blot\b|yuzde|%/i.test(claim))fail('tarih veya metin değeri finansal rakama dönüştürüldü');
  if(fact.unit && fact.metric!=='date' && fact.metric!=='text') {
    const unit=normalizeLabel(fact.unit);
    // TL/Adet may be written as a price in TL; scales must still be explicit.
    const equivalentCount=fact.metric==='share_count' && ['adet','pay'].includes(unit) && /\b(?:adet|pay)\b/.test(normalized);
    const equivalentPercent=fact.metric==='percentage' && unit==='%' && /%|\byuzde\b/.test(normalized);
    if(!equivalentCount && !equivalentPercent && !normalized.includes(unit.split('/')[0].trim()))fail('tweet para birimi veya ölçeği değiştirdi');
  }
  // Scope qualifiers describe amounts and holdings, not calendar dates or
  // durations. "12 ay süreli" need not repeat "azami bütçe".
  if(!shareEvent || !FINANCIAL_METRICS.includes(fact.metric))return;
  if(fact.scope==='prior_cumulative' && !/daha once|onceki|islem oncesi/.test(normalized))fail('önceki birikim günlük işlem veya son toplam gibi anlatılıyor');
  if(fact.scope==='cumulative' && !/toplam|kumulatif|bugune kadar/.test(normalized))fail('program toplamı günlük işlem gibi anlatılıyor');
  if(['cumulative','prior_cumulative'].includes(fact.scope) && /\bbugun\b|gunluk|bu islemde|bir islemde/.test(normalized))fail('program birikimi tek günün işlemi gibi anlatılıyor');
  // Scope is expressed by the sentence's verb/qualifier, which the model may
  // legitimately omit from its narrow numeric binding ("600.000.000 TL").
  // The binding still proves the exact value/unit; completed spending or
  // buying in that sentence still blocks a planned amount.
  const scopeContext=normalizeLabel(sentence);
  if(fact.scope==='planned' && (!/azami|plan|hedef|ayril|ayir|butce|fon|ongor|tavan|geri alinabilecek|geri alinmasina/.test(scopeContext)
    || executedPayment.test(scopeContext) || executedPurchase.test(scopeContext)))fail('program sınırı veya bütçesi gerçekleşmiş işlem gibi anlatılıyor');
  if(fact.scope==='holding' && !/sahip|bakiye|eldeki|pay[ıi]|pay oran/.test(normalized))fail('eldeki paylar yeni işlem gibi anlatılıyor');
  if(fact.scope==='transaction' && /program toplami|program.{0,20}toplam|daha once|islem oncesi/.test(normalized))fail('işlem miktarı program birikimi gibi anlatılıyor');
  if(fact.scope==='transaction' && (fact.transactionRowsOnDate??0)>1 && ['nominal_amount','share_count','cash_amount'].includes(fact.metric) && !/bir islemde|islemlerden biri|tek islemde/.test(normalized))fail('çok satırlı günün tek işlemi günlük toplam gibi anlatılıyor');
}

export function validateWrittenDraft(value:unknown,analysis:SourceAnalysis):string {
  const draft=value as WrittenDraft;
  if(!draft || draft.status!=='ready' || !text(draft.body,600))fail('tweetin kaynak ve anlam kontrolü geçilemedi');
  if(!Array.isArray(draft.usedFactIds) || draft.usedFactIds.length>12 || !Array.isArray(draft.numericClaims) || draft.numericClaims.length>30)fail('tweet kanıt eşleştirmesi eksik');
  const facts=new Map(analysis.facts.map(fact=>[fact.id,fact]));
  if(!draft.usedFactIds.every(id=>typeof id==='string' && facts.has(id)))fail('tweet bilinmeyen olgu kullandı');
  const intervals:Array<{start:number;end:number}>=[];
  for(const binding of draft.numericClaims) {
    if(!binding || !text(binding.text,600) || !draft.usedFactIds.includes(binding.factId))fail('sayı kanıtına bağlanmadı');
    const fact=facts.get(binding.factId)!;
    const first=draft.body.indexOf(binding.text);
    if(first<0 || !numbers(binding.text).length)fail('sayısal ifade tweet içinde yok');
    if(!numbers(binding.text).every(number=>numbers(fact.value).some(source=>source.value===number.value)))fail('tweette kaynakta olmayan veya değiştirilmiş sayı var');
    for(let offset=first;offset>=0;offset=draft.body.indexOf(binding.text,offset+1)) {
      try {validateNumericMeaning(binding.text,fact,analysis.event.kind!=='other',claimSentence(draft.body,offset,offset+binding.text.length));}
      catch(error) {if(error instanceof SourceValidationError)error.context={factId:fact.id,metric:fact.metric,scope:fact.scope};throw error;}
      intervals.push({start:offset,end:offset+binding.text.length});
    }
  }
  for(const number of numbers(draft.body))if(!intervals.some(interval=>interval.start<=number.start && interval.end>=number.end))fail('tweette kanıtsız sayı veya tarih var');
  const body=normalizeLabel(draft.body);
  if(/\bbugun\b/.test(body))fail('göreli tarih yerine kaynak işlem tarihi kullanılmalı');
  if(analysis.event.kind==='ownership_transaction' && /geri al/.test(body))fail('ortak pay işlemi şirket geri alımı gibi anlatılıyor');
  if(['decision','proposal','application','expectation'].includes(analysis.event.stage) && (executedPurchase.test(body) || executedPayment.test(body)
    || /\b(?:tamamlandi|gerceklesti|gerceklestirdi|gerceklestirildi)(?:gini|gine|ginden)?\b/.test(body)))fail('işlem aşaması gerçekleşme olarak değiştirildi');
  if(analysis.event.stage==='application' && /onaylandi|onayladi/.test(body))fail('başvuru onay gibi anlatılıyor');
  if(analysis.event.direction==='sell' && /geri aldi|satin al|(?:pay|hisse).{0,50}al(?:di|indi|mis)|alim.{0,30}(?:yap|gerceklestir)/.test(body))fail('satış alış gibi anlatılıyor');
  if(analysis.event.direction==='buy' && /geri sat|(?:pay|hisse).{0,50}sat(?:ti|ildi|mis)|satis.{0,30}(?:yap|gerceklestir)/.test(body))fail('alış satış gibi anlatılıyor');
  if(analysis.event.kind==='ownership_transaction' && analysis.event.actor) {
    const name=normalizeLabel(analysis.event.actor).replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(word=>word.length>1 && !['ve','as','anonim','sirketi','sanayi','ticaret','yatirim','holding','portfoy','yonetimi'].includes(word));
    if(!name.length || !name.slice(0,2).every(word=>body.includes(word)))fail('pay işlemini gerçekleştiren taraf tweet içinde korunmadı');
  }
  if(/\n|https?:\/\/|#[\p{L}\p{N}]|```|^[\s]*[-*]/u.test(draft.body))fail('tweet gövde biçimi hatalı');
  return draft.body.trim();
}
