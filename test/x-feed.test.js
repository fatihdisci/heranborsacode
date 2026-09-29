import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {database} from './db-harness';
import {ingestPosts,isFinancialPost} from '../src/x/feed';
import {parseNitterFeed,pollXAccount} from '../src/x/poll';
import {fetchSourceBundle} from '../src/ai/content';
import {readerContent} from '../src/reader/content';
import {deliverOne} from '../src/telegram/outbox';
let sql,env;
const started = '2026-09-28T10:00:00.000Z';
const make=(n,text='SPK, yatırım fonlarının tasfiyesini açıkladı.')=>({id:String(2000000000000000000n+BigInt(n)),text,publishedAt:'2026-09-28T10:01:00.000Z'});
beforeEach(()=>{({sql,env}=database());vi.useFakeTimers();vi.setSystemTime(new Date(started));});
afterEach(()=>{sql.close();vi.useRealTimers();vi.unstubAllGlobals();});
async function seed(){await ingestPosts(env,'haskologlu',[{...make(1),publishedAt:started}]);vi.setSystemTime(new Date('2026-09-28T10:02:00.000Z'));}
it('filters general news and accepts Turkish market and fund developments',()=>{
  for(const text of ['Borsa İstanbul güne düşüşle başladı.','Yatırım fonlarına kayyum atandı.','SPK manipülasyon soruşturması başlattı.','Yatırımcılar, fonlarına ulaşamıyor.','Halka arz tarihi açıklandı.','Fon soruşturmasında 4. dalga operasyon başladı.','Özata Denizcilik yöneticisi hakkında yakalama kararı.'])expect(isFinancialPost(text)).toBe(true);
  for(const text of ['Seçim tartışması büyüyor.','Yeni telefon satışa sunuldu.','Müzede fon müziği açıldı.','İstanbul’da yağmur var.','Kapıyı açtı.'])expect(isFinancialPost(text)).toBe(false);
});
it('baselines without importing old posts, ingests only new relevant IDs once',async()=>{
  await seed();
  await ingestPosts(env,'haskologlu',[make(4),make(1),make(3,'Bugün hava güneşli.'),{...make(2),publishedAt:'2026-09-27T10:00:00Z'}]);
  await ingestPosts(env,'haskologlu',[make(4)]);
  expect(sql.prepare('SELECT count(*) n FROM feed_items').get().n).toBe(1);
  expect(sql.prepare('SELECT count(*) n FROM telegram_outbox').get().n).toBe(1);
  expect(sql.prepare('SELECT kind,payload FROM telegram_outbox').get().kind).toBe('priority_message');
  expect(sql.prepare('SELECT source,url,type,category FROM feed_items').get()).toMatchObject({source:'X · @haskologlu',type:'news',category:null,url:`https://x.com/haskologlu/status/${make(4).id}`});
});
it('keeps a delayed X post in the feed without a stale Telegram alert',async()=>{
  await seed();
  vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
  await ingestPosts(env,'haskologlu',[make(2)]);
  expect(sql.prepare('SELECT count(*) AS n FROM feed_items').get().n).toBe(1);
  expect(sql.prepare('SELECT count(*) AS n FROM telegram_outbox').get().n).toBe(0);
});
it('rolls back the cursor when queue persistence fails',async()=>{
  await seed();
  sql.exec("CREATE TRIGGER fail_x BEFORE INSERT ON telegram_outbox BEGIN SELECT RAISE(ABORT,'failure'); END");
  await expect(ingestPosts(env,'haskologlu',[make(2)])).rejects.toThrow();
  expect(sql.prepare('SELECT count(*) n FROM feed_items').get().n).toBe(0);
  sql.exec('DROP TRIGGER fail_x');
  expect((await ingestPosts(env,'haskologlu',[make(2)])).inserted).toBe(1);
});
it('rejects unknown accounts, invalid dates and future posts',async()=>{
  await expect(ingestPosts(env,'other',[])).rejects.toThrow('unknown_account');
  await expect(ingestPosts(env,'haskologlu',[{...make(1),publishedAt:'bad'}])).rejects.toThrow('invalid_post_date');
  await expect(ingestPosts(env,'haskologlu',[{...make(1),publishedAt:'2030-01-01'}])).rejects.toThrow('invalid_post_date');
});
it('rejects Nitter block pages and ignores reposts attributed to other accounts',()=>{
  expect(()=>parseNitterFeed('<html>Verify your browser</html>','haskologlu')).toThrow();
  const item=(user)=>`<item><title>SPK fon kararı…</title><description><![CDATA[<p>SPK fon kararı tam metni</p>]]></description><link>https://nitter.example/${user}/status/${make(1).id}#m</link><pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate></item>`;
  const posts=parseNitterFeed(`<rss><channel>${item('haskologlu')}${item('other')}</channel></rss>`,'haskologlu');
  expect(posts).toHaveLength(1);
  expect(posts[0].text).toBe("SPK fon kararı tam metni");
});
it('uses stored post text for reader and AI, and delivers through finance outbox',async()=>{
  await seed();await ingestPosts(env,'haskologlu',[make(2)]);
  const item=sql.prepare('SELECT * FROM feed_items').get();
  const fetch=vi.fn(async()=>new Response(JSON.stringify({ok:true,result:{message_id:88}})));
  vi.stubGlobal('fetch',fetch);
  expect((await fetchSourceBundle(item)).text).toContain('bağımsız doğrulanmış haber değildir');
  expect((await readerContent(env,item)).blocks[0].text).toBe(make(2).text);
  expect(fetch).not.toHaveBeenCalled();
  await deliverOne(env);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sql.prepare('SELECT status FROM telegram_outbox').get().status).toBe('sent');
});
it('does not initialize a baseline on failed upstream responses',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{expect(options.redirect).toBe('manual');return new Response('rate limited',{status:429});}));
  await expect(pollXAccount({...env,X_NITTER_BASE_URL:'https://nitter.example'},'haskologlu')).rejects.toThrow('429');
  expect(sql.prepare("SELECT value FROM system_state WHERE key='x_cursor:haskologlu'").get()).toBeUndefined();
});
it('keeps quoted authors distinct from the monitored author',()=>{
  const xml=`<rss><channel><item><title>Kısa başlık…</title><link>https://nitter.cf/haskologlu/status/${make(1).id}</link><pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Bu açıklamayı aktarıyorum.</p><hr/><blockquote><b>Başka hesap (@other)</b><p>SPK yatırım fonlarına ilişkin karar verdi.</p></blockquote>]]></description></item></channel></rss>`;
  const [post]=parseNitterFeed(xml,'haskologlu');
  expect(post.text).toBe('Bu açıklamayı aktarıyorum.\n\nAlıntılanan paylaşım — Başka hesap (@other):\nSPK yatırım fonlarına ilişkin karar verdi.');
});
it('honors server retry delay and preserves cursor on rate limits',async()=>{
  await seed();
  const before=sql.prepare("SELECT value FROM system_state WHERE key='x_cursor:haskologlu'").get().value;
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('slow down',{status:429,headers:{'retry-after':'900'}})));
  await expect(pollXAccount({...env,X_NITTER_BASE_URL:'https://nitter.cf'},'haskologlu')).rejects.toMatchObject({retryAfterMs:900000});
  expect(sql.prepare("SELECT value FROM system_state WHERE key='x_cursor:haskologlu'").get().value).toBe(before);
});
