import { parseHTML } from 'linkedom';
import type { SourceAttachment } from './content';

// Read JSON values without executing Next.js scripts. Brackets inside escaped
// filenames or strings must not terminate the attachment array.
function jsonValue(text:string,start:number):unknown {
  const stack:string[]=[];let quoted=false,escaped=false;
  for(let i=start;i<text.length;i++) {
    const c=text[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}
    if(c==='{'||c==='[')stack.push(c);
    else if(c==='}'||c===']') {
      const open=stack.pop();if(open!==(c==='}'?'{':'['))throw new Error('Kaynak KAP ek verisi geçersiz');
      if(!stack.length)return JSON.parse(text.slice(start,i+1));
    }
  }
  throw new Error('Kaynak KAP ek verisi tamamlanmadı');
}
export function kapAttachments(html:string,url:string):SourceAttachment[]|null {
  const target=new URL(url),id=target.pathname.match(/^\/tr\/Bildirim\/(\d+)$/)?.[1];
  if(!id||!['www.kap.org.tr','kap.org.tr'].includes(target.hostname))return null;
  const {document}=parseHTML(html);const chunks:string[]=[];
  for(const script of document.querySelectorAll('script')) {
    const match=(script.textContent??'').match(/^\s*self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?\s*$/);
    if(!match)continue;
    try{const value=JSON.parse(match[1]);if(value[0]===1&&typeof value[1]==='string')chunks.push(value[1]);}catch{/* unrelated malformed script */}
  }
  const text=chunks.join('');let expected:number|null=null;
  for(const match of text.matchAll(/"disclosureBasic"\s*:\s*(?=\{)/g)) {
    const basic=jsonValue(text,match.index!+match[0].length) as {disclosureIndex?:number;attachmentCount?:number};
    if(String(basic.disclosureIndex)!==id)throw new Error('Kaynak KAP bildirim kimliği eşleşmedi');
    if(!Number.isInteger(basic.attachmentCount)||basic.attachmentCount!<0)throw new Error('Kaynak KAP ek sayısı doğrulanamadı');
    if(expected!==null&&expected!==basic.attachmentCount)throw new Error('Kaynak KAP ek sayıları tutarsız');
    expected=basic.attachmentCount!;
  }
  if(expected===null)return null;
  const found=new Map<string,SourceAttachment>();
  for(const match of text.matchAll(/"attachments"\s*:\s*(?=\[)/g)) {
    const rows=jsonValue(text,match.index!+match[0].length) as Array<{objId?:string;fileName?:string;fileExtension?:string}>;
    for(const row of rows) {
      if(typeof row.objId!=='string'||!/^[a-f0-9]{32}$/i.test(row.objId)||typeof row.fileName!=='string'||!row.fileName.trim())throw new Error('Kaynak KAP ek dosyası doğrulanamadı');
      const attachment={url:`https://www.kap.org.tr/tr/api/file/download/${row.objId}`,filename:row.fileName,isPdf:row.fileExtension?.toLowerCase()==='pdf'||/\.pdf$/i.test(row.fileName)};
      const prior=found.get(row.objId);if(prior&&prior.filename!==attachment.filename)throw new Error('Kaynak KAP ek dosyası tutarsız');
      found.set(row.objId,attachment);
    }
  }
  if(found.size!==expected)throw new Error('Kaynak KAP ekleri eksik; eksik kaynakla taslak üretilmedi');
  return [...found.values()];
}
