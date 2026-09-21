import { describe, expect, it } from 'vitest';
import { validateSteps } from '../src/commands/catalog';
import { extractKapSymbols } from '../src/commands/symbols';

describe('command center validation', () => {
  it('normalizes allowed steps and bounds delays', () => {
    expect(validateSteps([{botUsername:'@B0PT_BOT',command:'/derinlik THYAO',delaySeconds:99}])).toEqual([
      {botUsername:'b0pt_bot',command:'/derinlik THYAO',delaySeconds:30},
    ]);
  });

  it('rejects unknown bots, multiline commands and oversized flows', () => {
    expect(validateSteps([{botUsername:'unknown_bot',command:'/test'}])).toBeNull();
    expect(validateSteps([{botUsername:'b0pt_bot',command:'/test\n/second'}])).toBeNull();
    expect(validateSteps(Array.from({length:81},()=>({botUsername:'b0pt_bot',command:'/doviz'})))).toBeNull();
  });

  it('extracts and deduplicates official KAP company symbols', () => {
    const html = '<a href="/tr/sirket-bilgileri/ozet/1-a"><div>THYAO</div></a><a href="/tr/sirket-bilgileri/ozet/2-b"><div>ASELS</div></a><a href="/tr/sirket-bilgileri/ozet/3-c"><div>THYAO</div></a>';
    expect(extractKapSymbols(html)).toEqual(['ASELS','THYAO']);
  });
});
