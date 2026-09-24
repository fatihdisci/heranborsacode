import {it,expect,vi,afterEach} from 'vitest';
import {database} from './db-harness';
import {listFeed} from '../src/db/feed';
import {generateTweetDraft} from '../src/ai/tweet';
import {feedKeyboard} from '../src/telegram/buttons';
afterEach(()=>vi.unstubAllGlobals());
function add(sql,id,category){sql.prepare('INSERT INTO feed_items(id,type,source,source_ref,title,body,url,tickers_json,category,priority) VALUES (?,\'news\',\'OpenAI\',?,\'Codex model update\',\'New model announced\',\'https://openai.com/news/a\',\'[]\',?,\'high\')').run(id,`ai:${id}`,category);}
it('shows only AI records and filters user-facing categories',async()=>{
 const {sql,env}=database();add(sql,1,'openai');add(sql,2,'claude');
 sql.prepare("INSERT INTO feed_items(type,source,source_ref,title,url) VALUES ('kap','KAP','kap:old','Old finance','https://example.com')").run();
 expect((await listFeed(env,{limit:30})).items).toHaveLength(2);
 expect((await listFeed(env,{category:'claude',limit:30})).items.map(row=>row.category)).toEqual(['claude']);
});
it('formats reset Telegram buttons with visible attribution',()=>{
 const item={id:5,category:'resets',url:'https://x.com/a',title:'Reset',source:'Codex Resets'};
 const keyboard=feedKeyboard(item);
 expect(keyboard[0][0].url).toBe('https://codex-resets.com/');
 expect(keyboard[0][1].callback_data).toBe('tweet:5');
});
it('uses one Responses call per draft, Turkish output and only the supplied note',async()=>{
 const {sql,env}=database();add(sql,1,'openai');env.OPENAI_API_KEY='test-only';
 const item=await env.DB.prepare('SELECT * FROM feed_items WHERE id=1').first();
 const inputs=[];
 vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
   if(url===item.url)return new Response('<html><article>Codex model update</article></html>',{headers:{'content-type':'text/html'}});
   const request=JSON.parse(init.body);expect(request.model).toBe('gpt-6-luna');inputs.push(JSON.parse(request.input[0].content[0].text));
   return new Response(JSON.stringify({status:'completed',output_text:inputs.length===1?'Codex için yeni model duyuruldu.':'Codex için yeni model duyuruldu. Haftalık limitimi de tam bitirmiştim :)'}),{headers:{'content-type':'application/json'}});
 }));
 sql.prepare("INSERT INTO ai_tweet_drafts(feed_item_id,tweet_text,model,source_digest,created_at) VALUES (1,?,'gpt-6-luna:vibe-radar-v3-shared-tr','old',CURRENT_TIMESTAMP)").run('Eski robotik haber taslağı');
 const first=await generateTweetDraft(env,item);
 expect(first.tweet).not.toContain('Eski robotik');
 const cached=await generateTweetDraft(env,item);
 expect(first.cached).toBe(false);expect(cached.cached).toBe(true);expect(inputs).toHaveLength(1);expect(inputs[0].userNote).toBe('');expect(inputs[0].language).toBe('tr');
 const noted=await generateTweetDraft(env,item,{language:'tr',tone:'commentary',note:'Haftalık limitimi yeni bitirmiştim'});
 expect(noted.tweet).toContain('Haftalık limitimi de tam bitirmiştim');
 expect(inputs).toHaveLength(2);expect(inputs[1]).toMatchObject({language:'tr',tone:'commentary',userNote:'Haftalık limitimi yeni bitirmiştim'});
 expect(sql.prepare('SELECT count(*) n FROM ai_tweet_drafts').get().n).toBe(1);
});
