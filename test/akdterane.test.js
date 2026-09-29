import {expect,it} from 'vitest';
import {database} from './db-harness';
import {AKDTERANE_TEMPLATE_ID,TERANE_TEMPLATE_ID,enqueueTemplateJob} from '../src/commands/jobs';

it('copies every Terane stock and delay into the AKD template and queues it',async()=>{
  const {sql,env}=database();
  try {
    const source=sql.prepare('SELECT steps_json FROM command_templates WHERE id=?').get(TERANE_TEMPLATE_ID);
    const akd=sql.prepare('SELECT name,steps_json FROM command_templates WHERE id=?').get(AKDTERANE_TEMPLATE_ID);
    const sourceSteps=JSON.parse(source.steps_json),akdSteps=JSON.parse(akd.steps_json);
    expect(akd.name).toBe('akdterane');
    expect(akdSteps).toHaveLength(14);
    expect(akdSteps).toEqual(sourceSteps.map(step=>({...step,command:step.command.replace('/derinlik ','/akd ')})));
    const queued=await enqueueTemplateJob(env,AKDTERANE_TEMPLATE_ID,'telegram:123:1:/akdterane');
    expect(queued).toMatchObject({name:'akdterane',created:true,steps:akdSteps});
    expect(sql.prepare('SELECT template_id FROM command_jobs WHERE id=?').get(queued.id).template_id).toBe(AKDTERANE_TEMPLATE_ID);
  } finally {sql.close();}
});
