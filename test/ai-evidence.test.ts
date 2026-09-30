import { describe, expect, it } from 'vitest';
import fixture from './fixtures/egegy-buyback.json';
import { validateAnalysis, validateWrittenDraft, type SourceAnalysis } from '../src/ai/evidence';
import { proseScopeFor, type SourceDocument } from '../src/ai/source-document';
import selecDocument from './fixtures/selec-program.json';
import selecAnalyses from './fixtures/selec-model-analyses.json';
import selecWriterOutputs from './fixtures/selec-writer-outputs.json';
import { extractArticleSource } from '../src/ai/source-extract';

const title='Payların Geri Alınmasına İlişkin Bildirim';
const document=fixture.document as SourceDocument;
const fresh=()=>structuredClone(fixture.analysis) as SourceAnalysis;

describe('EGEGY real disclosure and model response regression',()=>{
  it('restores an equivalent date fact to the exact quoted source spelling',()=>{
    const result=validateAnalysis(fresh(),document,[],title);
    expect(result.facts[0].value).toBe('30 Eylül 2026');
    expect(result.facts[1]).toMatchObject({value:'93.546',metric:'share_count',scope:'transaction'});
    expect(result.facts[2]).toMatchObject({value:'1.384.306',metric:'cash_amount',scope:'transaction'});
    expect(validateWrittenDraft({status:'ready',body:'EGEYAPI Avrupa GYO, 30 Eylül 2026 tarihinde 93.546 adet payı 1.384.306 TL karşılığında geri aldı.',usedFactIds:['f1','f2','f3'],numericClaims:[
      {text:'30 Eylül 2026 tarihinde',factId:'f1'},
      {text:'93.546 adet payı',factId:'f2'},
      {text:'1.384.306 TL karşılığında',factId:'f3'},
    ]},result)).toContain('93.546 adet');
  });
  it.each(['29.09.2026','30.09.2025','31.09.2026'])('rejects a different or invalid date: %s',date=>{
    const analysis=fresh();analysis.facts[0].value=date;
    expect(()=>validateAnalysis(analysis,document,[],title)).toThrow('olgu değeri');
  });
  it('rejects a different transaction day, even if another historical row contains it',()=>{
    const analysis=fresh();analysis.facts[1].transactionDate='29.09.2026';
    expect(()=>validateAnalysis(analysis,document,[],title)).toThrow('işlem tarihi');
  });
  it('keeps exact amounts and does not convert nominal TL to share count',()=>{
    const altered=fresh();altered.facts[2].value='1.384.307';
    expect(()=>validateAnalysis(altered,document,[],title)).toThrow('olgu değeri');
    const nominal=fresh();nominal.facts[1].evidence=[{sourceId:'t4:r11:c3',quote:'93.546',location:null}];
    expect(()=>validateAnalysis(nominal,document,[],title)).toThrow('nominal/adet');
  });
  it('rejects presenting the daily amount as program cumulative',()=>{
    const analysis=fresh();analysis.facts[1].scope='cumulative';
    expect(()=>validateAnalysis(analysis,document,[],title)).toThrow('kapsam');
  });
});

it('separates daily totals from an adjacent cumulative sentence',()=>{
  const prose='30 Eylül 2026 tarihinde toplam 93.546 adet pay geri alınmıştır. Program kapsamında toplam geri alınan pay adedi 200.000 adede ulaşmıştır.';
  expect(proseScopeFor(prose,'93.546')).toBe('transaction');
  expect(proseScopeFor(prose,'200.000')).toBe('cumulative');
  expect(proseScopeFor('Daha önce geri alınan toplam pay adedi 200.000.','200.000')).toBe('prior_cumulative');
  expect(proseScopeFor('Geri alım için ayrılan fon 400.000.000 TL.','400.000.000')).toBe('planned');
});

describe('SELEC program decision and mixed units',()=>{
  const validate=(analysis:SourceAnalysis)=>validateAnalysis(analysis,selecDocument as SourceDocument,[],title);
  it.each([0,1])('accepts captured real analysis %s without confusing duration, count and nominal',index=>{
    const analysis=validate(structuredClone(selecAnalyses[index]) as SourceAnalysis);
    expect(analysis.event.kind).toBe('buyback_decision');
    expect(analysis.facts[0]).toMatchObject({metric:'share_count',scope:'planned',value:'5.000.000'});
  });
  it.each([1,2])('accepts captured writer output %s with sentence-level planned qualifiers',index=>{
    const analysis=validate(structuredClone(selecWriterOutputs[0]) as SourceAnalysis);
    const draft=selecWriterOutputs[index] as {body:string};
    expect(validateWrittenDraft(draft,analysis)).toBe(draft.body);
  });
  it('distinguishes future action and a completed decision from a completed purchase',()=>{
    const analysis=validate(structuredClone(selecAnalyses[0]) as SourceAnalysis);
    for(const body of ['Pay geri alım programı başlatılması kararı alınmıştır.','Program kapsamında geri alım gerçekleştirilecek.']) {
      expect(validateWrittenDraft({status:'ready',body,usedFactIds:[],numericClaims:[]},analysis)).toBe(body);
    }
    expect(()=>validateWrittenDraft({status:'ready',body:'Program kapsamında geri alım gerçekleştirildi.',usedFactIds:[],numericClaims:[]},analysis)).toThrow('aşaması');
  });
  it('writes a planned duration without demanding a budget adjective on the duration',()=>{
    const analysis=structuredClone(selecAnalyses[0]) as SourceAnalysis;
    analysis.facts[3].metric='duration';analysis.facts[3].unit='ay';
    const verified=validate(analysis);
    const body='Selçuk Ecza Deposu, 12 ay süreli geri alım programı başlattı. Program için azami 600.000.000 TL fon ayırdı; azami 5.000.000 adet pay geri alınabilecek.';
    expect(validateWrittenDraft({status:'ready',body,usedFactIds:['f1','f3','f4'],numericClaims:[
      {text:'12 ay süreli',factId:'f4'},{text:'azami 600.000.000 TL fon',factId:'f3'},
      {text:'azami 5.000.000 adet pay',factId:'f1'},
    ]},verified)).toBe(body);
  });
  it('restores source capitalization for durations without changing the number or unit',()=>{
    const analysis=structuredClone(selecAnalyses[0]) as SourceAnalysis;
    analysis.facts[3].metric='duration';analysis.facts[3].unit='ay';analysis.facts[3].value='12 Ay';
    expect(validate(analysis).facts[3].value).toBe('12 ay');
    analysis.facts[3].value='12 yıl';analysis.facts[3].unit='yıl';
    expect(()=>validate(analysis)).toThrow('olgu değeri');
  });
  it('does not accept a future buyback or planned implementation as executed evidence',()=>{
    const analysis=structuredClone(selecAnalyses[0]) as SourceAnalysis;
    analysis.event.kind='buyback_transaction';analysis.event.stage='executed';
    analysis.event.evidence=[{sourceId:'p9',quote:'Pay geri alım programının uygulanması, geri alım işlemlerinin gerçekleştirilmesi',location:null}];
    analysis.event.actor=null;analysis.event.subject=null;
    expect(()=>validate(analysis)).toThrow('fiili geri alım');
  });
  it.each(['planned','cumulative','prior_cumulative','holding'])('does not treat a %s date as a financial amount',scope=>{
    const analysis=validate(structuredClone(selecAnalyses[0]) as SourceAnalysis);
    analysis.facts[4].scope=scope as SourceAnalysis['facts'][number]['scope'];
    expect(validateWrittenDraft({status:'ready',body:'Şirket 30.09.2026 tarihinde geri alım programı başlatmaya karar verdi.',usedFactIds:['f5'],numericClaims:[{text:'30.09.2026 tarihinde',factId:'f5'}]},analysis)).toContain('30.09.2026');
  });
  it('continues rejecting a budget as money already spent and a decision as an executed buyback',()=>{
    const analysis=validate(structuredClone(selecAnalyses[0]) as SourceAnalysis);
    expect(()=>validateWrittenDraft({status:'ready',body:'Şirket 600.000.000 TL harcadı.',usedFactIds:['f3'],numericClaims:[{text:'600.000.000 TL harcadı',factId:'f3'}]},analysis)).toThrow('bütçesi');
    expect(()=>validateWrittenDraft({status:'ready',body:'Şirket paylarını geri aldı.',usedFactIds:[],numericClaims:[]},analysis)).toThrow('aşaması');
    expect(()=>validateWrittenDraft({status:'ready',body:'Şirket azami tutar olan 600.000.000 TL harcadı.',usedFactIds:['f3'],numericClaims:[{text:'600.000.000 TL',factId:'f3'}]},analysis)).toThrow('bütçesi');
    expect(()=>validateWrittenDraft({status:'ready',body:'Şirket 600.000.000 TL harcadı; azami fon belirlendi.',usedFactIds:['f3'],numericClaims:[{text:'600.000.000 TL',factId:'f3'}]},analysis)).toThrow('bütçesi');
  });
  it('rejects a nominal-only passage labelled as a count',()=>{
    const analysis=structuredClone(selecAnalyses[0]) as SourceAnalysis;
    analysis.facts[0].evidence=[{sourceId:'p5',quote:'toplam 5.000.000 TL nominal değerli payın geri alınabilmesine,',location:null}];
    expect(()=>validate(analysis)).toThrow('nominal tutar');
  });
  it('extracts duration units separately from money units',()=>{
    const source=extractArticleSource('<article><table><tr><td>Geri Alım Programının Uygulanacağı Süre</td><td>12 Ay</td></tr></table></article>',{type:'news',title:'Program',url:'https://example.com'});
    expect(source.document.tables[0].cells[0]).toMatchObject({metric:'duration',unit:'ay',text:'12 Ay'});
  });
});

it('accepts explicit share counts as pay or adet without converting nominal TL or lots',()=>{
  const analysis=validateAnalysis(fresh(),document,[],title);
  expect(validateWrittenDraft({status:'ready',body:'Şirket 93.546 pay geri aldı.',usedFactIds:['f2'],numericClaims:[{text:'93.546 pay',factId:'f2'}]},analysis)).toContain('93.546 pay');
  analysis.facts[1].unit='lot';
  expect(()=>validateWrittenDraft({status:'ready',body:'Şirket 93.546 pay geri aldı.',usedFactIds:['f2'],numericClaims:[{text:'93.546 pay',factId:'f2'}]},analysis)).toThrow('birimi');
});

it('allows explicitly paid cash alongside nominal value without equating the two',()=>{
  const analysis=fresh();
  const doc=structuredClone(document);
  const text='30 Eylül 2026 tarihinde 93.546 TL nominal değerli pay 1.384.306 TL karşılığında geri alınmıştır.';
  doc.passages.push({id:'mixed',text,section:''});
  analysis.facts=analysis.facts.filter(fact=>fact.metric!=='share_count').map((fact,i)=>({...fact,id:`f${i+1}`}));
  analysis.facts[1].evidence=[{sourceId:'mixed',quote:text,location:null}];
  expect(validateAnalysis(analysis,doc,[],title).facts[1].metric).toBe('cash_amount');
  const nominalOnly=structuredClone(analysis);
  nominalOnly.facts[1].value='93.546';
  expect(()=>validateAnalysis(nominalOnly,doc,[],title)).toThrow('nominal tutar');
});
