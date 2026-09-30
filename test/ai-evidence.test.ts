import { describe, expect, it } from 'vitest';
import fixture from './fixtures/egegy-buyback.json';
import { validateAnalysis, validateWrittenDraft, type SourceAnalysis } from '../src/ai/evidence';
import { proseScopeFor, type SourceDocument } from '../src/ai/source-document';

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
