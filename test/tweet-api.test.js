import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/api/routes';
import { generateTweetDraft } from '../src/ai/tweet';

vi.mock('../src/security/telegram',()=>({authorizeTelegramRequest:vi.fn(async()=>true)}));
vi.mock('../src/ai/tweet',()=>({generateTweetDraft:vi.fn()}));

const item={id:1,type:'kap',title:'Yeni sözleşme',category:null};
const env={OPENAI_API_KEY:'test-key',DB:{prepare:()=>({bind:()=>({first:async()=>item})})}};
const request=body=>new Request('https://example.test/api/tweet-draft',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
});

beforeEach(()=>vi.mocked(generateTweetDraft).mockReset().mockResolvedValue({tweet:'Taslak',cached:false}));

it('forwards regenerate and the extra instruction to tweet generation',async()=>{
  const response=await api(request({feedItemId:1,regenerate:true,instruction:'  Kısa yaz.  '}),env);
  expect(response.status).toBe(200);
  expect(generateTweetDraft).toHaveBeenCalledWith(env,item,{regenerate:true,instruction:'Kısa yaz.'});
});

it('rejects oversized and malformed instructions before calling AI',async()=>{
  expect((await api(request({feedItemId:1,instruction:'x'.repeat(501)}),env)).status).toBe(400);
  expect((await api(request({feedItemId:1,instruction:12}),env)).status).toBe(400);
  expect((await api(request({feedItemId:1,regenerate:'yes'}),env)).status).toBe(400);
  expect(generateTweetDraft).not.toHaveBeenCalled();
});

it('forwards the selected draft and rejects malformed or oversized revision context',async()=>{
  expect((await api(request({feedItemId:1,regenerate:true,instruction:'Başlığı değiştir.',previousDraft:'Önceki başlık\n\nAçıklama.'}),env)).status).toBe(200);
  expect(generateTweetDraft).toHaveBeenCalledWith(env,item,{regenerate:true,instruction:'Başlığı değiştir.',previousDraft:'Önceki başlık\n\nAçıklama.'});
  vi.mocked(generateTweetDraft).mockClear();
  for(const previousDraft of [42,'x'.repeat(3601)])expect((await api(request({feedItemId:1,previousDraft}),env)).status).toBe(400);
  expect(generateTweetDraft).not.toHaveBeenCalled();
});
