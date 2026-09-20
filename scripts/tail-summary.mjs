// Feed `wrangler tail --format json` through this to avoid displaying headers,
// request bodies, tokens or document contents during operational checks.
import readline from 'node:readline';
let lines=[];
for await (const line of readline.createInterface({input:process.stdin})) {
  if (line==='{') lines=[];
  lines.push(line);
  if (line!=='}') continue;
  try {
    const event=JSON.parse(lines.join('\n'));
    if(event.event?.request) continue;
    console.log(JSON.stringify({time:new Date(event.eventTimestamp).toISOString(),version:event.scriptVersion?.id,
      object:event.durableObjectId?.slice(0,10),kind:event.executionModel,cpuMs:event.cpuTime,
      outcome:event.outcome,exceptions:(event.exceptions??[]).map(e=>e.name)}));
  } catch { /* ignore CLI preamble */ }
  lines=[];
}
