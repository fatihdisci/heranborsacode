import { describe, expect, it } from 'vitest';
import fixture from './fixtures/otkar-contract.json';
import { validateAnalysis, validateWrittenDraft, supportingEvidence, type SourceAnalysis } from '../src/ai/evidence';
import type { SourceDocument } from '../src/ai/source-document';

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
});
