import {afterEach,expect,it,vi} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import {database} from './db-harness';
import {retryUnnotifiedCommandJobs} from '../src/commands/routes';
import {SON_HALKA_ARZLAR_TEMPLATE_ID} from '../src/commands/jobs';

afterEach(()=>vi.unstubAllGlobals());

it('sends one PDF containing photo and image-document results, then does not resend it',async()=>{
  const {sql,env}=database();
  try {
    const id='c9fca71b-01de-4380-9745-7d78ee35e8e6';
    sql.prepare("INSERT INTO command_jobs(id,template_id,name,steps_json,status,finished_at) VALUES (?,?,?,'[]','completed',CURRENT_TIMESTAMP)")
      .run(id,SON_HALKA_ARZLAR_TEMPLATE_ID,'Son halka arzlar');
    const add=sql.prepare("INSERT INTO command_results(job_id,step_index,bot_username,command,response_text,response_kind,media_key,file_name) VALUES (?,?,?,?,?,?,?,?)");
    add.run(id,0,'ucretsizderinlikbot','/derinlik NETGL','', 'image',`commands/${id}/a.png`,'a.png');
    add.run(id,1,'ucretsizderinlikbot','/derinlik BKRGY','', 'file',`commands/${id}/b.png`,'b.png');
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WZkAAAAASUVORK5CYII=','base64');
    let saved;
    const media={
      get:vi.fn(async()=>({httpMetadata:{contentType:'image/png'},arrayBuffer:async()=>png.buffer.slice(png.byteOffset,png.byteOffset+png.byteLength)})),
      put:vi.fn(async(_key,data)=>{saved=data;}),
    };
    const send=vi.fn(async()=>new Response(JSON.stringify({ok:true,result:{message_id:42}})));
    vi.stubGlobal('fetch',send);
    await retryUnnotifiedCommandJobs({...env,COMMAND_MEDIA:media},'https://worker.test');
    await retryUnnotifiedCommandJobs({...env,COMMAND_MEDIA:media},'https://worker.test');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('/sendDocument');
    expect(send.mock.calls[0][1].body.get('caption')).toContain('2 görsel tek PDF');
    expect((await PDFDocument.load(saved)).getPageCount()).toBe(2);
    expect(sql.prepare('SELECT notified_at FROM command_jobs WHERE id=?').get(id).notified_at).toBeTruthy();
  } finally {sql.close();}
});
