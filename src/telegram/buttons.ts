import type { FeedItem } from '../types';
import type { InlineButton } from './client';
export function feedKeyboard(item: FeedItem, sourceButton?: {text:string;url:string}): InlineButton[][] {
  const rows: InlineButton[][] = [[sourceButton ?? {text:item.type === 'kap' ? "🔗 KAP'ta Aç" : '🔗 Haberi Aç',url:item.url}]];
  if (item.type === 'spk' || /devre kesici/i.test(item.title)) return rows;
  rows.push([{text:item.type === 'kap' ? '📖 Bildirimi oku' : '📖 Haberi oku',callback_data:`read:${item.id}`},
    {text:'✦ Tweet oluştur',callback_data:`tweet:${item.id}`}]);
  return rows;
}
