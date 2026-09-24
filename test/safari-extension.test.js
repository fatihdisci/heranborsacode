import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const root='safari-extension/extension';
function helpers() {
 const context={URL};context.globalThis=context;
 runInNewContext(readFileSync(`${root}/helpers.js`,'utf8'),context);
 return context.VibeRadarHelpers;
}
it('extracts the selected tweet ID and canonical URL',()=>{
 const H=helpers();
 expect(H.extractTweetId('https://x.com/alice/status/1234567890123456789/photo/1')).toBe('1234567890123456789');
 expect(H.extractTweetUrl(['https://x.com/alice','https://twitter.com/alice/status/1234567890123456789?ref=home']).url).toBe('https://x.com/alice/status/1234567890123456789');
 expect(H.extractTweetUrl(['https://attacker.test/alice/status/1234567890123456789'])).toBeNull();
});
it('normalizes reference data and message payload without exposing token',()=>{
 const H=helpers();
 const payload=H.makePayload('quote','  tam da limitim bitmişti ',{text:' Codex limits reset. ',url:'https://x.com/a/status/1234567890123456789',quotedTweet:{text:'Another post'}});
 expect(JSON.parse(JSON.stringify(payload))).toEqual({mode:'quote',userNote:'tam da limitim bitmişti',reference:{text:'Codex limits reset.',id:'1234567890123456789',url:'https://x.com/a/status/1234567890123456789',quotedTweet:{text:'Another post'}}});
 expect(H.makePayload('post','',payload.reference)).toBeNull();
 const manifest=JSON.parse(readFileSync(`${root}/manifest.json`,'utf8'));
 expect(manifest.manifest_version).toBe(3);
 expect(manifest.content_scripts[0].matches).toEqual(['https://x.com/*','https://twitter.com/*']);
 expect(readFileSync(`${root}/content.js`,'utf8')).not.toContain('SAFARI_EXTENSION_TOKEN');
 expect(readFileSync(`${root}/content.js`,'utf8')).not.toContain('api.openai.com');
});
