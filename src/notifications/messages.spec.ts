import { messageFor, type MessageInput, templateFor } from './messages.js';

const base: MessageInput = {
  kind: 'BOOKED',
  audience: 'client',
  locale: 'en',
  businessName: 'Studio X',
  masterName: 'Anna',
  title: null,
  startsAt: new Date('2026-11-27T14:00:00Z'), // 17:00 in Moscow
  timeZone: 'Europe/Moscow',
  clientName: 'Maria',
};

const has = (input: Partial<MessageInput>, ...parts: string[]) => {
  const { text } = messageFor({ ...base, ...input } as MessageInput);
  for (const part of parts) expect(text).toContain(part);
  return text;
};

describe('messageFor: client', () => {
  it('BOOKED en', () => {
    has({}, "You're booked", 'Fri 27 Nov', '17:00', 'Anna', 'Studio X');
  });

  it('BOOKED ru', () => {
    has({ locale: 'ru' }, 'Вы записаны', 'пт', '27', '17:00', 'Anna', 'Studio X');
  });

  it('names the group or session when there is one', () => {
    has({ title: 'Morning yoga' }, 'Morning yoga');
  });

  it('MOVED en / ru', () => {
    has({ kind: 'MOVED' }, 'moved', '17:00');
    has({ kind: 'MOVED', locale: 'ru' }, 'перенесена', '17:00');
  });

  it('CANCELLED en / ru', () => {
    has({ kind: 'CANCELLED' }, 'cancelled', 'Fri 27 Nov');
    has({ kind: 'CANCELLED', locale: 'ru' }, 'отменена', '27');
  });

  it('REMINDER says tomorrow for a day, in N hours for hours', () => {
    has({ kind: 'REMINDER', offsetMinutes: 1440 }, 'Tomorrow', '17:00');
    has({ kind: 'REMINDER', offsetMinutes: 2880 }, 'In 2 days', '17:00');
    has({ kind: 'REMINDER', offsetMinutes: 120 }, 'In 2 hours', '17:00');
    has({ kind: 'REMINDER', offsetMinutes: 60 }, 'In 1 hour', '17:00');
    has({ kind: 'REMINDER', offsetMinutes: 1440, locale: 'ru' }, 'Завтра', '17:00');
    has({ kind: 'REMINDER', offsetMinutes: 180, locale: 'ru' }, 'Через 3 часа', '17:00');
    has({ kind: 'REMINDER', offsetMinutes: 60, locale: 'ru' }, 'Через 1 час', '17:00');
    has({ kind: 'REMINDER', offsetMinutes: 2880, locale: 'ru' }, 'Через 2 дня', '17:00');
  });

  it('CHANNEL_ON is the booked text, the link and a promise of reminders', () => {
    has(
      { kind: 'CHANNEL_ON', manageLink: 'https://app.test/b/abc' },
      "You're booked",
      'https://app.test/b/abc',
      'reminders here',
    );
    has(
      { kind: 'CHANNEL_ON', locale: 'ru', manageLink: 'https://app.test/b/abc' },
      'Вы записаны',
      'https://app.test/b/abc',
      'напоминания',
    );
  });

  it('CHANNEL_ON without the link is a bug, not an empty «Manage your booking: »', () => {
    expect(() => messageFor({ ...base, kind: 'CHANNEL_ON' })).toThrow('manageLink');
  });

  it('has a subject', () => {
    expect(messageFor(base).subject).not.toBe('');
  });
});

describe('messageFor: staff', () => {
  const staff = { audience: 'staff' } as const;

  it('BOOKED names the client and the time', () => {
    has({ ...staff }, 'New booking', 'Maria', 'Fri 27 Nov 17:00');
    has({ ...staff, locale: 'ru' }, 'Новая запись', 'Maria', '17:00');
  });

  it('MOVED shows from and to, and the other master when it changed', () => {
    const from = new Date('2026-11-26T09:00:00Z'); // 12:00 in Moscow
    const text = has({ ...staff, kind: 'MOVED', fromStartsAt: from }, 'moved', 'Maria', '12:00', '17:00');
    expect(text).not.toContain('Ivan');
    has({ ...staff, kind: 'MOVED', fromStartsAt: from, fromMasterName: 'Ivan' }, 'Ivan', 'Anna');
    has({ ...staff, kind: 'MOVED', fromStartsAt: from, locale: 'ru' }, 'перенесена', '12:00', '17:00');
  });

  it('CANCELLED', () => {
    has({ ...staff, kind: 'CANCELLED' }, 'cancelled', 'Maria');
    has({ ...staff, kind: 'CANCELLED', locale: 'ru' }, 'отменена', 'Maria');
  });

  it('names the business: one account can work in several', () => {
    has({ ...staff }, 'Studio X');
    has({ ...staff, kind: 'MOVED', fromStartsAt: new Date('2026-11-26T09:00:00Z') }, 'Studio X');
    has({ ...staff, kind: 'CANCELLED' }, 'Studio X');
  });

  it('has its own subject for a new booking, not the client’s «confirmed»', () => {
    expect(messageFor({ ...base, ...staff }).subject).toBe('New booking');
    expect(messageFor({ ...base, ...staff, locale: 'ru' }).subject).toBe('Новая запись');
    expect(messageFor(base).subject).toBe('Booking confirmed');
  });

  it('never carries the manage link', () => {
    const text = has({ ...staff, kind: 'BOOKED', manageLink: 'https://app.test/b/abc' } as Partial<MessageInput>);
    expect(text).not.toContain('https://app.test/b/abc');
  });
});

describe('messageFor: time zone', () => {
  it('shows the wall clock of the business across the DST change', () => {
    // Berlin: CEST (+2) until 2026-10-25 03:00, then CET (+1).
    const summer = has({ timeZone: 'Europe/Berlin', startsAt: new Date('2026-10-24T15:00:00Z') }, '17:00');
    const winter = has({ timeZone: 'Europe/Berlin', startsAt: new Date('2026-10-26T16:00:00Z') }, '17:00');
    expect(summer).toContain('Sat 24 Oct');
    expect(winter).toContain('Mon 26 Oct');
  });
});

describe('templateFor', () => {
  const template = (input: Partial<MessageInput>) => templateFor({ ...base, ...input } as MessageInput);

  it('names the template by kind and audience, in the language of the client', () => {
    expect(template({}).name).toBe('bookedup_booked_client');
    expect(
      template({ kind: 'CHANNEL_ON', locale: 'ru', manageLink: 'https://app.example.com/booking/x' }),
    ).toMatchObject({
      name: 'bookedup_channel_on_client',
      language: 'ru',
    });
  });

  it('a reminder in ru: the lead, when, the master and the business, in the order of the template', () => {
    expect(template({ kind: 'REMINDER', locale: 'ru', offsetMinutes: 1440 }).params).toEqual([
      'Завтра',
      'пт 27 нояб., 17:00',
      'Anna',
      'Studio X',
    ]);
  });

  it('puts the group or the session before the time', () => {
    expect(template({ title: 'Morning yoga' }).params[0]).toBe('Morning yoga, Fri 27 Nov, 17:00');
  });

  it('CHANNEL_ON ends with the manage link', () => {
    expect(template({ kind: 'CHANNEL_ON', manageLink: 'https://app.example.com/booking/x' }).params.at(-1)).toBe(
      'https://app.example.com/booking/x',
    );
  });

  it('CHANNEL_ON without the link is a bug, not an empty placeholder', () => {
    expect(() => template({ kind: 'CHANNEL_ON' })).toThrow(/manage link/);
  });

  it('an empty name is named as itself, not as a missing link', () => {
    expect(() => template({ masterName: '' })).toThrow(/parameter 2/);
  });

  it('WhatsApp refuses a line break or a run of spaces in a parameter: they are folded to one space', () => {
    expect(template({ businessName: 'Studio\n  X   Y', title: 'Yoga\tfor  all' }).params).toEqual([
      'Yoga for all, Fri 27 Nov, 17:00',
      'Anna',
      'Studio X Y',
    ]);
  });

  it('is for clients: staff reach WhatsApp nowhere', () => {
    expect(() => template({ audience: 'staff' })).toThrow(/clients/);
  });
});
