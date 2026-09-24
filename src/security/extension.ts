import type {Env} from '../types';

const encoder=new TextEncoder();
async function digest(value:string):Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
}

/** Compare fixed-length digests so token length and first differing byte do not short-circuit. */
export async function authorizeExtension(request:Request,env:Env):Promise<boolean> {
  const secret=env.SAFARI_EXTENSION_TOKEN;
  if(!secret||secret.length<32) return false;
  const match=/^Bearer ([^\s]+)$/.exec(request.headers.get('authorization')??'');
  if(!match) return false;
  const [expected,received]=await Promise.all([digest(secret),digest(match[1])]);
  let difference=0;
  for(let i=0;i<expected.length;i++) difference|=expected[i]^received[i];
  return difference===0;
}

export async function takeExtensionRateSlot(env:Env,now=Date.now()):Promise<boolean> {
  const minute=Math.floor(now/60_000);
  const row=await env.DB.prepare('INSERT INTO safari_extension_rate(window_minute,used) VALUES (?,1) ON CONFLICT(window_minute) DO UPDATE SET used=used+1 WHERE used<15 RETURNING used').bind(minute).first<{used:number}>();
  return Boolean(row);
}
