export type Category = 'openai' | 'claude' | 'coding' | 'resets' | 'ai-news';
export type SourceKind = 'rss' | 'json' | 'status' | 'html' | 'sitemap';
export interface Source { id: string; name: string; kind: SourceKind; url: string; category: Category; priority: 'high' | 'normal'; intervalMinutes: number; attribution?: { label: string; url: string }; }
export const SOURCES: Source[] = [
  {id:'openai-news',name:'OpenAI',kind:'rss',url:'https://openai.com/news/rss.xml',category:'openai',priority:'high',intervalMinutes:15},
  {id:'codex-releases',name:'Codex Releases',kind:'rss',url:'https://github.com/openai/codex/releases.atom',category:'openai',priority:'normal',intervalMinutes:30},
  {id:'openai-status',name:'OpenAI Status',kind:'status',url:'https://status.openai.com/history.atom',category:'openai',priority:'normal',intervalMinutes:15},
  {id:'anthropic-news',name:'Anthropic News',kind:'sitemap',url:'https://www.anthropic.com/sitemap.xml',category:'claude',priority:'high',intervalMinutes:30},
  {id:'claude-code-releases',name:'Claude Code Releases',kind:'rss',url:'https://github.com/anthropics/claude-code/releases.atom',category:'claude',priority:'normal',intervalMinutes:30},
  {id:'claude-status',name:'Claude Status',kind:'status',url:'https://anthropic.statuspage.io/history.atom',category:'claude',priority:'normal',intervalMinutes:15},
  {id:'cursor-changelog',name:'Cursor Changelog',kind:'html',url:'https://cursor.com/changelog',category:'coding',priority:'normal',intervalMinutes:30},
  {id:'github-changelog',name:'GitHub Changelog',kind:'rss',url:'https://github.blog/changelog/feed/',category:'coding',priority:'normal',intervalMinutes:15},
  {id:'google-ai',name:'Google AI',kind:'rss',url:'https://blog.google/innovation-and-ai/technology/ai/rss/',category:'ai-news',priority:'normal',intervalMinutes:30},
  {id:'deepmind',name:'Google DeepMind',kind:'rss',url:'https://deepmind.google/blog/rss.xml',category:'ai-news',priority:'normal',intervalMinutes:30},
  {id:'techcrunch-ai',name:'TechCrunch AI',kind:'rss',url:'https://techcrunch.com/category/artificial-intelligence/feed/',category:'ai-news',priority:'normal',intervalMinutes:30},
  {id:'verge-ai',name:'The Verge AI',kind:'rss',url:'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',category:'ai-news',priority:'normal',intervalMinutes:30},
  {id:'mit-review-ai',name:'MIT Technology Review AI',kind:'rss',url:'https://www.technologyreview.com/topic/artificial-intelligence/feed/',category:'ai-news',priority:'normal',intervalMinutes:30},
  {id:'huggingface-blog',name:'Hugging Face Blog',kind:'rss',url:'https://huggingface.co/blog/feed.xml',category:'ai-news',priority:'normal',intervalMinutes:30},
  {id:'codex-resets',name:'Codex Resets',kind:'json',url:'https://codex-resets.com/api/v1/resets',category:'resets',priority:'high',intervalMinutes:5,attribution:{label:'Codex Resets',url:'https://codex-resets.com/'}},
];
export const sourceById = (id: string) => SOURCES.find(source => source.id === id);
