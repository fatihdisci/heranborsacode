import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { processAction, type ActionLane } from './actions';

export class TelegramActions extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const lane = new URL(request.url).searchParams.get('lane');
    if (lane !== 'read' && lane !== 'tweet') return new Response('Invalid lane',{status:400});
    await this.ctx.storage.put('lane',lane);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now()+100);
    return new Response('OK');
  }
  async alarm(): Promise<void> {
    const lane = await this.ctx.storage.get<ActionLane>('lane');
    if (!lane) return;
    await this.ctx.storage.setAlarm(Date.now()+181_000);
    const next = await processAction(this.env,lane);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Date.now()+next);
  }
}
