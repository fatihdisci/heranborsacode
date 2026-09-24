import type { Source } from './registry';
export type Classification = 'release' | 'model' | 'feature' | 'coding' | 'reset' | 'limits' | 'status' | 'news' | 'tool';
export interface Decision { priority: 'high' | 'normal' | 'ignore'; classification: Classification; }
const important = /\b(?:launch\w*|introduc\w*|releas\w*|announc\w*|new model|now available|availability|major update|price|pricing|limit\w*|reset\w*|codex|chatgpt|claude|copilot|gemini|agent\w*|cursor|api)\b/i;
const noise = /\b(?:webinar|event|conference|sponsor|hiring|job|case study|customer story|partner spotlight|weekly roundup|minor bug|documentation fix|docs only)\b/i;
const coding = /\b(?:codex|claude code|copilot|cursor|coding agent|developer agent|code review)\b/i;
const model = /\b(?:model|gpt-|claude (?:opus|sonnet|haiku)|gemini \d|reasoning model)\b/i;
const limits = /\b(?:limit|quota|pricing|price|rate limit|usage)\b/i;
const feature = /\b(?:feature|launch\w*|introduc\w*|now available|releas\w*|update|rollout)\b/i;
export function classify(source: Source, title: string, summary = ''): Decision {
  if (source.category === 'resets') return {priority:'high',classification:'reset'};
  if (source.id === 'codex-releases' || source.id === 'claude-code-releases') return {priority:'normal',classification:'release'};
  if (source.kind === 'status') return {priority:'normal',classification:'status'};
  const text = `${title} ${summary}`;
  if (source.id === 'cursor-changelog' && !noise.test(title)) return {priority:'normal',classification:'coding'};
  if (noise.test(title) || !important.test(text)) return {priority:'ignore',classification:'news'};
  const classification: Classification = limits.test(text) ? 'limits' : model.test(text) ? 'model' : coding.test(text) ? 'coding' : feature.test(text) ? 'feature' : 'news';
  // Individual patch releases and generic status updates stay in the Mini App.
  const productFeature=/(?:chatgpt|claude|gemini|codex)/i.test(title) && /\b(?:launch\w*|introduc\w*|new|feature\w*|available)\b/i.test(title);
  const editorial=new Set(['techcrunch-ai','verge-ai','mit-review-ai','huggingface-blog']).has(source.id);
  const high = !editorial && (classification === 'model' || classification === 'limits' || productFeature || (coding.test(title) && feature.test(title)));
  return {priority: high ? 'high' : 'normal',classification};
}
