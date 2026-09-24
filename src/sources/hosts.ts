const HOSTS=['openai.com','github.com','github.blog','anthropic.com','anthropic.statuspage.io','google.com','deepmind.google','status.openai.com','cursor.com','codex-resets.com','x.com','techcrunch.com','theverge.com','technologyreview.com','huggingface.co'];
export function allowedSourceUrl(value:string):boolean {
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&HOSTS.some(host=>url.hostname===host||url.hostname.endsWith(`.${host}`));}
  catch{return false;}
}
