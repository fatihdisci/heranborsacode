import { describe, expect, it } from 'vitest';
import fixture from './fixtures/otkar-contract.json';
import modelAnalysis from './fixtures/otkar-model-analysis.json';
import { validateAnalysis, validateWrittenDraft, supportingEvidence, SourceValidationError, type SourceAnalysis } from '../src/ai/evidence';
import type { SourceDocument } from '../src/ai/source-document';
import { SYSTEM_PROMPT } from '../src/ai/prompt';

const document=fixture.document as SourceDocument;
const issuer=document.passages.find(p=>p.id==='kap-issuer')!;
const contract=document.passages.find(p=>p.text.startsWith('Şirketimiz, çeşitli tiplerde'))!;
const delivery=document.passages.find(p=>p.text.startsWith('İlgili araç teslimatlarının'))!;
const ref=(passage:{id:string;text:string})=>({sourceId:passage.id,quote:passage.text,location:null});
function analysis():SourceAnalysis {
  return {status:'ready',event:{kind:'other',stage:'executed',direction:'none',
    actor:issuer.text,subject:issuer.text,eventDate:null,
    summary:'Otokar, tekerlekli zırhlı araç tedariki ve entegre lojistik destek hizmetleri için ihracat sözleşmesi imzaladı.',
    // This is a reproduction of the omitted identity reference, not a saved
    // model response. Source passages are from the actual OTKAR disclosure.
    evidence:[ref(contract)]},facts:[
      {id:'f1',meaning:'İmzalanan ihracat sözleşmesinin bedeli',value:'1.472.080.360',metric:'cash_amount',scope:'unknown',unit:'USD',transactionDate:null,evidence:[{
        sourceId:contract.id,quote:contract.text.split('. Sözleşme,')[0]+'.',location:null}]},
      {id:'f2',meaning:'Araç teslimatlarının başlayacağı yıl',value:'2027',metric:'date',scope:'planned',unit:null,transactionDate:null,evidence:[ref(delivery)]},
      {id:'f3',meaning:'Planlanan teslimat süresi',value:'3 yıl',metric:'duration',scope:'planned',unit:'yıl',transactionDate:null,evidence:[ref(delivery)]},
    ],ambiguities:[]};
}

describe('OTKAR first-person KAP identity regression',()=>{
  it('combines the official issuer identity with the separately proved contract event',()=>{
    const verified=validateAnalysis(analysis(),document,[],fixture.title);
    expect(verified.event.evidence.map(ref=>ref.sourceId)).toEqual([contract.id,'kap-issuer']);
    expect(supportingEvidence(verified,document)).toContainEqual(issuer);
    const body='Otokar, zırhlı araç tedariki ve lojistik destek için 1.472.080.360 USD bedelli ihracat sözleşmesi imzaladı. Teslimatların 2027 yılından itibaren 3 yıl içinde tamamlanması planlanıyor.';
    expect(validateWrittenDraft({status:'ready',body,usedFactIds:['f1','f2','f3'],numericClaims:[
      {text:'1.472.080.360 USD bedelli',factId:'f1'},
      {text:'2027 yılından itibaren',factId:'f2'},
      {text:'3 yıl içinde',factId:'f3'},
    ]},verified)).toBe(body);
    expect(validateAnalysis(verified,document,[],fixture.title).event.evidence.filter(ref=>ref.sourceId==='kap-issuer')).toHaveLength(1);
  });
  it.each(['Otokar','Otokar Otomotiv ve Savunma Sanayi AŞ','Otokar Otomotiv ve Savunma Sanayi A. Ş.'])('accepts a source-backed issuer spelling: %s',name=>{
    const candidate=analysis();candidate.event.actor=name;candidate.event.subject=name;
    expect(validateAnalysis(candidate,document,[],fixture.title).event.actor).toBe(name);
  });
  it.each(['Karsan','Otokar Avrupa','Otok','Sanayi'])('rejects another or invented party: %s',name=>{
    const candidate=analysis();candidate.event.actor=name;candidate.event.subject=null;
    expect(()=>validateAnalysis(candidate,document,[],fixture.title)).toThrow('işlemin tarafı');
  });
  it('rejects issuer identity as the only event evidence',()=>{
    const candidate=analysis();candidate.event.evidence=[ref(issuer)];
    expect(()=>validateAnalysis(candidate,document,[],fixture.title)).toThrow('yalnız yayıncı kimliğinden');
  });
  it('identifies the failed party field and the official source identity for a bounded correction',()=>{
    const candidate=analysis();candidate.event.subject='Tekerlekli zırhlı araçlar';
    let caught:unknown;
    try {validateAnalysis(candidate,document,[],fixture.title);}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(SourceValidationError);
    expect((caught as SourceValidationError).context).toEqual({partyRole:'subject',partyName:'Tekerlekli zırhlı araçlar',issuerName:issuer.text});
  });
  it('does not attach an issuer to an unrelated third-party event',()=>{
    const candidate=analysis();candidate.event.evidence=[ref(delivery)];candidate.facts=[];
    expect(()=>validateAnalysis(candidate,document,[],fixture.title)).toThrow('işlemin tarafı');
  });
  it('does not infer the trader from first-person prose and the issuer identity',()=>{
    const candidate=analysis();candidate.event.kind='ownership_transaction';candidate.event.direction='buy';candidate.facts=[];
    expect(()=>validateAnalysis(candidate,document,[],'Pay Alım Satım Bildirimi')).toThrow('işlemin tarafı');
    candidate.event.evidence.push(ref(issuer));
    expect(()=>validateAnalysis(candidate,document,[],'Pay Alım Satım Bildirimi')).toThrow('işlemi yapan taraf');
  });
  it('continues rejecting altered contract amounts',()=>{
    const candidate=analysis();candidate.facts[0].value='1.472.080.361';
    expect(()=>validateAnalysis(candidate,document,[],fixture.title)).toThrow('olgu değeri');
    const verified=validateAnalysis(analysis(),document,[],fixture.title);
    expect(()=>validateWrittenDraft({status:'ready',body:'Otokar 1.472.080.361 USD bedelli sözleşme imzaladı.',usedFactIds:['f1'],numericClaims:[{text:'1.472.080.361 USD bedelli',factId:'f1'}]},verified)).toThrow('değiştirilmiş sayı');
  });
  it('accepts the real monetary source values even when the model called a contract amount unknown',()=>{
    const verified=validateAnalysis(structuredClone(modelAnalysis),document,[],fixture.title);
    expect(verified.facts[0]).toMatchObject({metric:'cash_amount',value:'1.472.080.360 USD',unit:'USD',scope:'transaction'});
    expect(verified.facts[1]).toMatchObject({metric:'cash_amount',value:'441.624.108 USD',scope:'planned'});
    const body='Otokar, 1.472.080.360 USD bedelli zırhlı araç ihracat sözleşmesi imzaladı. Yürürlüğe girmesi resmî onay, teminat işlemleri ve avans ödemesine bağlı.';
    expect(validateWrittenDraft({status:'ready',body,usedFactIds:['f1'],numericClaims:[{text:'1.472.080.360 USD bedelli',factId:'f1'}]},verified)).toBe(body);
    expect(SYSTEM_PROMPT).toContain('ilk cümlede şirket adı, ana tutar ve gerçek işlem aşaması');
  });
  it('does not infer a currency absent from the source',()=>{
    const candidate=analysis();candidate.facts=[{...candidate.facts[0],metric:'unknown',unit:'EUR'}];
    expect(()=>validateAnalysis(candidate,document,[],fixture.title)).toThrow('alıntıda birim yok');
  });
  it('does not attach a neighbouring monetary amount to a non-monetary number',()=>{
    const candidate=analysis();const doc=structuredClone(document);
    const prose='Teslim edilecek araç sayısı 30 olarak belirlenmiştir; başka bir hizmetin bedeli 100 USD olarak açıklanmıştır.';
    doc.passages.push({id:'different-units',text:prose,section:''});
    candidate.facts=[{id:'f1',meaning:'Araç sayısı',value:'30',metric:'unknown',scope:'planned',unit:'USD',transactionDate:null,evidence:[{sourceId:'different-units',quote:prose,location:null}]}];
    const verified=validateAnalysis(candidate,doc,[],fixture.title);
    expect(verified.facts[0].metric).toBe('unknown');
    expect(()=>validateWrittenDraft({status:'ready',body:'Otokar, 30 USD bedelli sözleşme imzaladı.',usedFactIds:['f1'],numericClaims:[{text:'30 USD bedelli',factId:'f1'}]},verified)).toThrow('finansal rakama');
  });
  it('does not turn a nominal TL amount into a monetary contract value',()=>{
    const candidate=analysis();const doc=structuredClone(document);
    const nominal='Şirketimiz, 50.000 TL nominal tutarlı pay geri almıştır.';
    doc.passages.push({id:'nominal',text:nominal,section:''});
    candidate.facts=[{id:'f1',meaning:'Nominal değer',value:'50.000 TL',metric:'unknown',scope:'transaction',unit:'TL',transactionDate:null,evidence:[{sourceId:'nominal',quote:nominal,location:null}]}];
    const verified=validateAnalysis(candidate,doc,[],fixture.title);
    expect(verified.facts[0].metric).toBe('unknown');
    expect(()=>validateWrittenDraft({status:'ready',body:'Otokar, 50.000 TL bedelli sözleşme imzaladı.',usedFactIds:['f1'],numericClaims:[{text:'50.000 TL bedelli',factId:'f1'}]},verified)).toThrow('finansal rakama');
  });
});
