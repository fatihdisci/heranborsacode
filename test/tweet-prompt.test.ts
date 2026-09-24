import {describe,it,expect} from 'vitest';
import {SYSTEM_PROMPT,PROMPT_VERSION,formatDraft} from '../src/ai/prompt';

describe('Turkish tweet editor',()=>{
 it('uses a new cache version and requires Turkish for English sources and reference tweets',()=>{
   expect(PROMPT_VERSION).toBe('vibe-radar-v3-shared-tr');
   expect(SYSTEM_PROMPT).toContain('Nihai metin HER ZAMAN TÜRKÇE');
   expect(SYSTEM_PROMPT).toContain('İngilizce veya başka dildeki kaynağı');
   expect(SYSTEM_PROMPT).toContain('Referans tweet varsa düz çeviri veya özet üretme');
   expect(()=>formatDraft('The new feature is now available for users.','https://openai.com/news/a')).toThrow(/Türkçe/);
 });
 it('rejects robotic PR phrases and preserves concise natural Turkish',()=>{
   expect(()=>formatDraft('Bu devrim niteliğinde bir gelişme.','https://openai.com/news/a')).toThrow(/PR/);
   expect(formatDraft('Codex için yeni özellik geldi.','https://openai.com/news/a')).toBe('Codex için yeni özellik geldi.\n\nhttps://openai.com/news/a');
 });
 it('does not invent personal experience without a note and keeps a supplied note possible',()=>{
   expect(SYSTEM_PROMPT).toContain('Fatih\'in söylemediği kişisel deneyimi');
   expect(SYSTEM_PROMPT).toContain('Not varsa anlamını koruyarak doğalca metne yedir');
   expect(()=>formatDraft('Codex limitimi bitirmiştim.','https://openai.com/news/a')).toThrow(/kişisel/);
   expect(formatDraft('Codex limitimi bitirmiştim.','https://openai.com/news/a',true)).toContain('limitimi bitirmiştim');
 });
 it('preserves technical product names, limits emojis and hashtags',()=>{
   expect(SYSTEM_PROMPT).toContain('ChatGPT, Codex, Claude, Claude Code, Cursor, API, agent, prompt, context window, token ve benchmark');
   expect(formatDraft('Claude Code ve Codex için API desteği geldi.','https://openai.com/news/a')).toContain('Claude Code ve Codex');
   expect(()=>formatDraft('#AI duyuru','https://openai.com')).toThrow();
   expect(()=>formatDraft('Güncelleme geldi 😀🚀✨','https://openai.com')).toThrow(/emoji/);
 });
 it('grounds claims in the source and appends only the verified link',()=>{
   expect(SYSTEM_PROMPT).toContain('Kaynağın söylemediği özellik, fayda, sayı, tarih, fiyat, limit');
   expect(SYSTEM_PROMPT).toContain('Kaynak yetersizse yalnız INSUFFICIENT_SOURCE döndür');
   expect(()=>formatDraft('Bak https://fake.test','https://openai.com')).toThrow();
   expect(()=>formatDraft('INSUFFICIENT_SOURCE','https://openai.com')).toThrow();
 });
});
