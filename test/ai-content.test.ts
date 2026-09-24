import {describe,expect,it} from 'vitest';
import {extractAttachments,extractReadableContent} from '../src/ai/content';
import {allowedSourceUrl} from '../src/sources/hosts';
describe('AI source preparation',()=>{
 it('follows DeepMind articles redirected to the official Google Blog',()=>{
  expect(allowedSourceUrl('https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-8-live-with-live-avatar/')).toBe(true);
  expect(allowedSourceUrl('https://blog.google.evil.test/article')).toBe(false);
 });
 it('reads JSON-LD article text without following page scripts',()=>{
  const html='<html><head><script type="application/ld+json">{"@type":"NewsArticle","headline":"Codex update","articleBody":"Codex has a new feature."}</script></head><body><article>More details.</article><script>secret()</script></body></html>';
  const text=extractReadableContent(html);
  expect(text).toContain('Codex has a new feature.');expect(text).toContain('More details.');expect(text).not.toContain('secret()');
 });
 it('keeps trusted article attachments and rejects unrelated hosts',()=>{
  const html='<a href="/assets/notes.pdf">Release notes</a><a href="https://evil.test/file.pdf">Unknown</a>';
  expect(extractAttachments(html,'https://openai.com/news/codex')).toEqual([{url:'https://openai.com/assets/notes.pdf',filename:'notes.pdf',isPdf:true}]);
 });
});
