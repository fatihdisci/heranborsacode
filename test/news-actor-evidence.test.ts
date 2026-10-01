import {expect,it} from 'vitest';
import {actorNames,validateAnalysis,validateWrittenDraft,type SourceAnalysis} from '../src/ai/evidence';
import {plainDocument} from '../src/ai/source-document';

const actor='Norges Bank Investment Management';
const quote='Düzenleyici kuruma yapılan bildirime göre Norges Bank Investment Management (NBIM), SA-RA Enerji İnşaat’ın ilk halka arzında satışa sunulan hisselerin yaklaşık yüzde 5,2’sine talepte bulundu.';
function analysed(name=actor):SourceAnalysis {
  const document=plainDocument(quote);
  return validateAnalysis({status:'ready',event:{kind:'ownership_transaction',stage:'application',direction:'buy',actor:name,subject:'SA-RA Enerji İnşaat',summary:'NBIM, halka arzda talepte bulundu.',eventDate:null,evidence:[{sourceId:document.passages[0].id,quote,location:null}]},facts:[],ambiguities:[]},document,[],'Halka arz katılımı');
}
const draft=(body:string)=>({status:'ready',body,usedFactIds:[],numericClaims:[]});

it.each([actor,`${actor} (NBIM)`])('accepts the source-defined acronym for %s',name=>{
  const analysis=analysed(name);
  expect(actorNames(analysis.event)).toContain('NBIM');
  const body='NBIM, SA-RA Enerji İnşaat’ın halka arzında talepte bulundu.';
  expect(validateWrittenDraft(draft(body),analysis)).toBe(body);
  expect(validateWrittenDraft(draft('NBIM’nin halka arz talebi bildirildi.'),analysis)).toContain('NBIM');
});

it.each(['Tera','Norveç Varlık Fonu','XNBIM','Norgesli Bankacı'])('rejects an unverified replacement or partial match: %s',name=>{
  expect(()=>validateWrittenDraft(draft(`${name}, halka arzda talepte bulundu.`),analysed())).toThrow('taraf tweet içinde');
});

it('does not invent acronyms or reuse another institution’s acronym',()=>{
  const analysis=analysed();
  analysis.event.evidence[0].quote=`${actor}, talepte bulundu. Başka Kurum (NBIM) açıklama yaptı.`;
  expect(actorNames(analysis.event)).not.toContain('NBIM');
  expect(()=>validateWrittenDraft(draft('NBIM, halka arzda talepte bulundu.'),analysis)).toThrow('taraf tweet içinde');
});

it('returns the expected actor to the bounded repair pass and still rejects completed purchases',()=>{
  const analysis=analysed();
  try {validateWrittenDraft(draft('Tera, halka arzda talepte bulundu.'),analysis);throw new Error('expected rejection');}
  catch(error) {expect(error).toMatchObject({context:{partyRole:'actor',partyName:actor}});}
  expect(()=>validateWrittenDraft(draft('NBIM, halka arzda hisseleri satın aldı.'),analysis)).toThrow('aşaması');
});
