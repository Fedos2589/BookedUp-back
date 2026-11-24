import { whatsappTemplates } from './whatsapp-templates.js';

describe('whatsappTemplates', () => {
  const all = whatsappTemplates();

  it('lists every client kind in both languages', () => {
    expect(all.map((t) => `${t.name}/${t.language}`).sort()).toEqual(
      ['booked', 'cancelled', 'channel_on', 'moved', 'reminder']
        .flatMap((kind) => ['en', 'ru'].map((lang) => `bookedup_${kind}_client/${lang}`))
        .sort(),
    );
  });

  it('writes the body with one {{n}} per parameter, in order', () => {
    for (const t of all) {
      const placeholders = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(placeholders).toEqual(t.params.map((_, i) => i + 1));
    }
  });

  it('shows a reminder body like the message the client gets', () => {
    const t = all.find((x) => x.name === 'bookedup_reminder_client' && x.language === 'en');
    expect(t?.body).toBe('{{1}}: {{2}}, with {{3}}, {{4}}');
  });
});
