import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { database } from './db-harness';
import { pollRSSSource } from '../src/rss/poll';
import { generateTweetDraft } from '../src/ai/tweet';
import { enqueueStatement,flushCircuitBreakers,deliverOne } from '../src/telegram/outbox';
let sql,env;
beforeEach(()=>{({sql,env}=database());});
afterEach(()=>{sql.close();vi.unstubAllGlobals();});
const source={name:'Test Ekonomi',url:'https://example.com/rss'};
function rss(amount) {return `<rss><channel><item><title>Vestel yeni sözleşme imzaladı</title><link>https://example.com/news/1</link><description>Vestel, ${amount} milyon TL tutarında yeni sözleşme imzaladı.</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;}
it('handles RSS revisions and repeated polls without sending Telegram during ingestion',async()=>{
  sql.prepare("INSERT INTO system_state(key,value) VALUES (?,'1')").run('rss_baseline:'+source.url);
  let amount=10;
  const mock=vi.fn(async(url)=>{expect(url).toBe(source.url);return new Response(rss(amount));});
  vi.stubGlobal('fetch',mock);
  await pollRSSSource(env,source);await pollRSSSource(env,source);
  expect(sql.prepare('SELECT count(*) AS n FROM telegram_outbox').get().n).toBe(1);
  amount=20;await pollRSSSource(env,source);await pollRSSSource(env,source);
  expect(sql.prepare('SELECT count(*) AS n FROM telegram_outbox').get().n).toBe(2);
  expect(sql.prepare('SELECT count(*) AS n FROM feed_items').get().n).toBe(2);
});
it('rolls back source and feed when delivery persistence fails',async()=>{
  sql.prepare("INSERT INTO system_state(key,value) VALUES (?,'1')").run('rss_baseline:'+source.url);
  sql.exec("CREATE TRIGGER reject_queue BEFORE INSERT ON telegram_outbox BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(rss(10))));
  await expect(pollRSSSource(env,source)).rejects.toThrow();
  expect(sql.prepare('SELECT count(*) AS n FROM rss_items').get().n).toBe(0);
  expect(sql.prepare('SELECT count(*) AS n FROM feed_items').get().n).toBe(0);
});
it('upgrades only pending legacy messages and preserves sent/baseline records',()=>{
  sql.close();({sql,env}=database({queueMigration:false}));
  for(const [id,status] of [['1','pending'],['2','sent'],['3','baseline']]) {
    sql.prepare("INSERT INTO kap_disclosures(disclosure_id,title,url,content_hash,telegram_status) VALUES (?,'Pay Bazında Devre Kesici Bildirimi','https://example.com',?,?)").run(id,id,status);
    sql.prepare("INSERT INTO feed_items(type,source,source_ref,title,url,tickers_json) VALUES ('kap','KAP',?,'Pay Bazında Devre Kesici Bildirimi','https://example.com','[\"THYAO\"]')").run('kap:'+id);
  }
  sql.prepare("INSERT INTO kap_disclosures(disclosure_id,title,url,content_hash,telegram_status) VALUES ('4','Kayıp bildirim','https://example.com','4','pending')").run();
  sql.exec(readFileSync('migrations/0005_delivery_outbox.sql','utf8'));
  const rows=sql.prepare('SELECT id,status,kind FROM telegram_outbox').all();
  expect(rows).toHaveLength(2);expect(rows.find(row=>row.id==='kap:1')).toMatchObject({status:'buffered',kind:'dkb'});
  expect(sql.prepare("SELECT title FROM feed_items WHERE source_ref='kap:4'").get().title).toBe('Kayıp bildirim');
});
it('groups 100 DKBs into one accepted message and preserves all references',async()=>{
  const seen=new Date(Date.now()-13000).toISOString();
  for(let i=0;i<100;i++) await enqueueStatement(env,'kap:'+i,'dkb',{codes:['A'+String(i).padStart(4,'0')]},null,seen).run();
  await flushCircuitBreakers(env);
  const mock=vi.fn(async(_url,init)=>{expect(init.body.get('text').match(/#/g)).toHaveLength(100);expect(init.body.get('text').length).toBeLessThan(4096);return new Response(JSON.stringify({ok:true,result:{message_id:99}}));});
  vi.stubGlobal('fetch',mock);await deliverOne(env);
  expect(sql.prepare("SELECT count(*) AS n FROM telegram_outbox WHERE status='sent' AND source_ref IS NOT NULL").get().n).toBe(100);
  expect(mock).toHaveBeenCalledTimes(1);
});
it('keeps GPT-5.6 Luna, separates source data, caches validated output and rejects truncation',async()=>{
  sql.exec("INSERT INTO feed_items(type,source,source_ref,title,body,url,tickers_json) VALUES ('news','Test','rss:ai','Vestel sözleşme','2 milyon avro','https://example.com/news','[\"VESTL\"]')");
  const item=sql.prepare('SELECT * FROM feed_items').get();
  let incomplete=false;
  const mock=vi.fn(async(url,init)=>{
    if(url===item.url) return new Response('<article>Vestel, 2 milyon avroluk sözleşme imzaladı.</article>',{headers:{'content-type':'text/html'}});
    const body=JSON.parse(init.body);expect(body.model).toBe('gpt-6-luna');expect(body.instructions).toContain('brüt/net'.replace('brüt','Brüt'));
    expect(JSON.parse(body.input[0].content[0].text).target.url).toBe(item.url);
    return new Response(JSON.stringify({status:incomplete?'incomplete':'completed',output_text:'Vestel, 2 milyon avroluk sözleşme imzaladığını açıkladı.'}));
  });
  vi.stubGlobal('fetch',mock);
  const result=await generateTweetDraft({...env,OPENAI_API_KEY:'test-fake'},item);
  expect(result.tweet).toContain('#VESTL\n\nVestel');expect(result.tweet).toContain('🔗 '+item.url);
  expect((await generateTweetDraft({...env,OPENAI_API_KEY:'test-fake'},item)).cached).toBe(true);
  expect(mock).toHaveBeenCalledTimes(2);
  sql.exec('DELETE FROM ai_tweet_drafts');incomplete=true;
  await expect(generateTweetDraft({...env,OPENAI_API_KEY:'test-fake'},item)).rejects.toThrow('tamamlanmadı');
  expect(sql.prepare('SELECT count(*) AS n FROM ai_tweet_drafts').get().n).toBe(0);
});
