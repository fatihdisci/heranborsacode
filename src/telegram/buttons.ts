import type { FeedItem } from '../types';
import type { InlineButton } from './client';
export function feedKeyboard(item: FeedItem, sourceButton?:{text:string;url:string}):InlineButton[][] {
  if (!item.category) return [[sourceButton??{text:'Kaynağı aç',url:item.url}]];
  if (item.category==='resets') return [[{text:'Codex Resets',url:'https://codex-resets.com/'},{text:'Tweet oluştur',callback_data:`tweet:${item.id}`}]];
  return [[sourceButton??{text:'Kaynağı aç',url:item.url}],[{text:'Oku',callback_data:`read:${item.id}`},{text:'Tweet oluştur',callback_data:`tweet:${item.id}`}]];
}
