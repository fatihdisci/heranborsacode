import { describe, expect, it } from 'vitest';
import { COMMAND_BOTS, validateSteps } from '../src/commands/catalog';
import { extractKapSymbols } from '../src/commands/symbols';

describe('command center validation', () => {
  it('exposes only the two supported bots with understandable commands', () => {
    expect(COMMAND_BOTS.map(bot => bot.username)).toEqual(['b0pt_bot', 'ucretsizderinlikbot']);
    expect(COMMAND_BOTS[0].commands.find(command => command.id === 'derinlik')).toMatchObject({ label: 'Piyasa Derinliği (25 kademe)', pattern: '/derinlik {HISSE}' });
    expect(COMMAND_BOTS[0].commands.find(command => command.id === 'kurum')).toMatchObject({ argumentKind: 'text', pattern: '/kurum {ARGUMAN}' });
    expect(COMMAND_BOTS[1].commands.map(command => command.id)).toEqual(['derinlik', 'akd', 'takas', 'teorik', 'kurum']);
  });

  it('normalizes allowed steps and bounds delays', () => {
    expect(validateSteps([{botUsername:'@B0PT_BOT',command:'/derinlik THYAO',delaySeconds:99}])).toEqual([
      {botUsername:'b0pt_bot',command:'/derinlik THYAO',delaySeconds:30},
    ]);
    expect(validateSteps([{botUsername:'ucretsizderinlikbot',command:'/derinlik NETGL',delaySeconds:4.8}])).toEqual([
      {botUsername:'ucretsizderinlikbot',command:'/derinlik NETGL',delaySeconds:4.8},
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
