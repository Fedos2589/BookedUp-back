import { messageFor, type MessageInput, templateFor } from './messages.js';

const KINDS = ['BOOKED', 'MOVED', 'CANCELLED', 'REMINDER', 'CHANNEL_ON'] as const;
const LOCALES = ['en', 'ru'] as const;

export type WhatsappTemplate = { name: string; language: string; body: string; params: string[] };

// Every template WhatsApp must have approved: its name and language from `templateFor`, its body from the text the
// client gets (`messageFor`) with each parameter's value swapped for {{n}} — so the list can't drift from the code.
export const whatsappTemplates = (): WhatsappTemplate[] =>
  KINDS.flatMap((kind) =>
    LOCALES.map((locale) => {
      const input: MessageInput = {
        kind,
        audience: 'client',
        locale,
        businessName: 'BUSINESS',
        masterName: 'MASTER',
        title: null,
        startsAt: new Date('2026-11-27T14:00:00Z'),
        timeZone: 'UTC',
        clientName: 'CLIENT',
        offsetMinutes: 1440,
        manageLink: 'https://LINK',
      };
      const { name, language, params } = templateFor(input);
      let body = messageFor(input).text;
      let from = 0;
      params.forEach((value, i) => {
        const at = body.indexOf(value, from);
        const mark = `{{${i + 1}}}`;
        body = body.slice(0, at) + mark + body.slice(at + value.length);
        from = at + mark.length;
      });
      return { name, language, body, params: params.map((_, i) => `{{${i + 1}}}`) };
    }),
  );

export const whatsappTemplatesTable = (): string =>
  [
    '| Name | Language | Body | Parameters |',
    '| ---- | -------- | ---- | ---------- |',
    ...whatsappTemplates().map(
      (t) => `| \`${t.name}\` | ${t.language} | ${t.body.replaceAll('\n', ' ⏎ ')} | ${t.params.length} |`,
    ),
  ].join('\n');
