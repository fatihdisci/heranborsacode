import {describe,it,expect} from 'vitest';
import {parseRss} from '../src/rss/parser';
describe('RSS/Atom parser',()=>{
  it('reads an RSS announcement',()=>expect(parseRss('<rss><channel><item><title>Codex update</title><description>New feature</description><link>https://openai.com/news/a</link><pubDate>Tue, 22 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>')).toMatchObject([{title:'Codex update',description:'New feature',url:'https://openai.com/news/a'}]));
  it('reads an Atom release',()=>expect(parseRss('<feed><entry><title>Claude Code 1.0</title><link rel="alternate" href="https://github.com/anthropics/claude-code/releases/tag/v1"/><updated>2026-09-22T10:00:00Z</updated></entry></feed>')[0].url).toContain('github.com'));
});
