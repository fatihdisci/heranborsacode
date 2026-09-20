import { describe, expect, it, vi } from 'vitest';
import { connectTelegramBack, restoreFeedPosition } from '../public/navigation';
function dialog() {
  const d = new EventTarget(); d.open = false;
  d.close = vi.fn(() => { d.open = false; d.dispatchEvent(new Event('close')); });
  return d;
}
describe('Mini App back navigation', () => {
  it('shows native back only for an open sheet and closes the top sheet first', () => {
    const reader = dialog(), tweet = dialog();
    const BackButton = { show: vi.fn(), hide: vi.fn(), onClick: vi.fn() };
    const nav = connectTelegramBack({ initData:'test', isVersionAtLeast:()=>true, BackButton }, [reader,tweet]);
    expect(BackButton.hide).toHaveBeenCalled();
    reader.open = true; nav.sync(); expect(BackButton.show).toHaveBeenCalled();
    tweet.open = true; nav.back(); expect(tweet.close).toHaveBeenCalled(); expect(reader.open).toBe(true);
    nav.back(); expect(reader.open).toBe(false); expect(BackButton.hide).toHaveBeenCalledTimes(3);
    expect(BackButton.onClick).toHaveBeenCalledTimes(1);
  });
  it('does not call native UI in standalone browser or old clients', () => {
    const BackButton = { onClick:vi.fn(), show:vi.fn(), hide:vi.fn() };
    connectTelegramBack({ initData:'', isVersionAtLeast:()=>true, BackButton }, [dialog()]);
    connectTelegramBack({ initData:'test', isVersionAtLeast:()=>false, BackButton }, [dialog()]);
    expect(BackButton.onClick).not.toHaveBeenCalled();
    expect(()=>connectTelegramBack(undefined,[dialog()])).not.toThrow();
  });
  it('restores the exact feed position without smooth-scroll jumps', () => {
    const win={ scrollTo:vi.fn() }, doc={body:{classList:{remove:vi.fn()},style:{top:'-920px'}}};
    restoreFeedPosition(win,doc,920);
    expect(doc.body.style.top).toBe('');
    expect(win.scrollTo).toHaveBeenCalledWith({top:920,left:0,behavior:'instant'});
  });
});
