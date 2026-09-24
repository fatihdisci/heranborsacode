import type {Env} from '../types';

export const MODEL='gpt-6-luna';
interface OpenAIResponse {
  status?:string;
  output_text?:string;
  output?:Array<{content?:Array<{type?:string;text?:string}>}>;
}

export async function generateAIText(env:Env,instructions:string,input:Record<string,unknown>,attachments:Array<Record<string,unknown>>=[]):Promise<string> {
  if(!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY yapılandırılmamış');
  const content:Array<Record<string,unknown>>=[{type:'input_text',text:JSON.stringify(input)},...attachments];
  const response=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',signal:AbortSignal.timeout(100_000),
    headers:{authorization:`Bearer ${env.OPENAI_API_KEY}`,'content-type':'application/json'},
    body:JSON.stringify({model:MODEL,instructions,input:[{role:'user',content}],reasoning:{effort:'low'},text:{verbosity:'low'},max_output_tokens:900,store:false}),
  });
  if(!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  const result=await response.json<OpenAIResponse>();
  if(result.status&&result.status!=='completed') throw new Error('OpenAI yanıtı tamamlanmadı');
  const direct=result.output_text?.trim();
  return direct || (result.output??[]).flatMap(item=>item.content??[]).filter(part=>part.type==='output_text'&&part.text).map(part=>part.text!.trim()).join('\n').trim();
}
