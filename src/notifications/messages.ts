import type { Locale } from '../account/locale.js';

// The same two languages as the accounts' (src/account/locale.ts): one list to extend.
export type MessageLocale = Locale;

export type MessageInput = {
  kind: 'BOOKED' | 'MOVED' | 'CANCELLED' | 'REMINDER' | 'CHANNEL_ON';
  audience: 'client' | 'staff';
  locale: MessageLocale;
  businessName: string;
  masterName: string;
  // A group or a session, when the booking is for one.
  title: string | null;
  startsAt: Date;
  // MOVED, staff: where the booking was.
  fromStartsAt?: Date;
  fromMasterName?: string;
  timeZone: string;
  // Staff texts name the client.
  clientName: string;
  // REMINDER: how long before the start the reminder goes.
  offsetMinutes?: number;
  // CHANNEL_ON, client only.
  manageLink?: string;
};

// `url`: where a tap on a push goes (the booking's page for a client, the calendar for staff); the dispatcher
// adds it, `messageFor` doesn't know it.
export type Message = { subject: string; text: string; url?: string };

const LOCALE_TAG: Record<MessageLocale, string> = { en: 'en-GB', ru: 'ru-RU' };

const MINUTES_IN_HOUR = 60;
const MINUTES_IN_DAY = 1440;

// «Fri 27 Nov» / «пт 27 нояб.» — the day on the business's wall clock.
const dayOf = (date: Date, locale: MessageLocale, timeZone: string) => {
  const parts = new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => part.value);
  return parts.join(' ');
};

const timeOf = (date: Date, locale: MessageLocale, timeZone: string) =>
  new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);

type Units = { one: string; few: string; other: string };

const unitsOf = (n: number, locale: MessageLocale, units: Record<MessageLocale, Units>) => {
  const category = new Intl.PluralRules(locale).select(n);
  const forms = units[locale];
  return `${n} ${category === 'one' ? forms.one : category === 'few' ? forms.few : forms.other}`;
};

const HOURS: Record<MessageLocale, Units> = {
  en: { one: 'hour', few: 'hours', other: 'hours' },
  ru: { one: 'час', few: 'часа', other: 'часов' },
};
const DAYS: Record<MessageLocale, Units> = {
  en: { one: 'day', few: 'days', other: 'days' },
  ru: { one: 'день', few: 'дня', other: 'дней' },
};

// «Tomorrow» / «In 2 hours» / «Через 3 часа» from the offset.
const leadOf = (offsetMinutes: number, locale: MessageLocale) => {
  if (offsetMinutes === MINUTES_IN_DAY) return locale === 'ru' ? 'Завтра' : 'Tomorrow';
  const [n, units] =
    offsetMinutes % MINUTES_IN_DAY === 0
      ? [offsetMinutes / MINUTES_IN_DAY, DAYS]
      : [offsetMinutes / MINUTES_IN_HOUR, HOURS];
  return `${locale === 'ru' ? 'Через' : 'In'} ${unitsOf(n, locale, units)}`;
};

const WORDS = {
  en: {
    with: 'with',
    booked: "You're booked",
    moved: 'Your booking is moved to',
    cancelled: 'Your booking is cancelled',
    manage: 'Manage your booking',
    remindersHere: "You'll get reminders here.",
    newBooking: 'New booking',
    movedStaff: 'moved',
    bookingOf: 'Booking of',
    cancelledStaff: 'cancelled',
    subject: {
      BOOKED: 'Booking confirmed',
      MOVED: 'Booking moved',
      CANCELLED: 'Booking cancelled',
      REMINDER: 'Booking reminder',
      CHANNEL_ON: 'Booking confirmed',
    },
  },
  ru: {
    with: 'у',
    booked: 'Вы записаны',
    moved: 'Запись перенесена',
    cancelled: 'Запись отменена',
    manage: 'Управление записью',
    remindersHere: 'Сюда же придут напоминания.',
    newBooking: 'Новая запись',
    movedStaff: 'перенесена',
    bookingOf: 'Запись',
    cancelledStaff: 'отменена',
    subject: {
      BOOKED: 'Запись подтверждена',
      MOVED: 'Запись перенесена',
      CANCELLED: 'Запись отменена',
      REMINDER: 'Напоминание о записи',
      CHANNEL_ON: 'Запись подтверждена',
    },
  },
} as const;

const clientText = (input: MessageInput) => {
  const w = WORDS[input.locale];
  const { startsAt, timeZone, locale } = input;
  const when = `${dayOf(startsAt, locale, timeZone)}, ${timeOf(startsAt, locale, timeZone)}`;
  const slot = [input.title, when, `${w.with} ${input.masterName}`, input.businessName]
    .filter((part) => part !== null)
    .join(', ');
  switch (input.kind) {
    case 'BOOKED':
      return `${w.booked}: ${slot}`;
    case 'MOVED':
      return `${w.moved}: ${slot}`;
    case 'CANCELLED':
      return `${w.cancelled}: ${slot}`;
    case 'REMINDER':
      return `${leadOf(input.offsetMinutes ?? MINUTES_IN_DAY, locale)}: ${slot}`;
    case 'CHANNEL_ON':
      // The link is wiped from the event once sent (D5): a message without it is a bug, not a blank.
      if (!input.manageLink) throw new Error('CHANNEL_ON needs manageLink');
      return [`${w.booked}: ${slot}`, `${w.manage}: ${input.manageLink}`, w.remindersHere].join('\n');
  }
};

const staffText = (input: MessageInput) => {
  const w = WORDS[input.locale];
  const { locale, timeZone } = input;
  const at = (date: Date) => `${dayOf(date, locale, timeZone)} ${timeOf(date, locale, timeZone)}`;
  const title = input.title === null ? '' : `, ${input.title}`;
  // An account's channels serve every business it belongs to: say which one this is.
  const prefix = `${input.businessName} · `;
  switch (input.kind) {
    case 'BOOKED':
      return `${prefix}${w.newBooking}: ${input.clientName}, ${at(input.startsAt)}${title}`;
    case 'CANCELLED':
      return `${prefix}${w.bookingOf} ${input.clientName} ${w.cancelledStaff}: ${at(input.startsAt)}${title}`;
    case 'MOVED': {
      const from = [input.fromMasterName, input.fromStartsAt && at(input.fromStartsAt)].filter(Boolean).join(', ');
      const to = [input.fromMasterName && input.masterName, at(input.startsAt)].filter(Boolean).join(', ');
      return `${prefix}${w.bookingOf} ${input.clientName} ${w.movedStaff}: ${from ? `${from} → ` : ''}${to}${title}`;
    }
    case 'REMINDER':
    case 'CHANNEL_ON':
      throw new Error(`Staff gets no ${input.kind} message`);
  }
};

// «Booking confirmed» is for the client; the master is told of a new booking.
const subjectOf = (input: MessageInput) =>
  input.audience === 'staff' && input.kind === 'BOOKED'
    ? WORDS[input.locale].newBooking
    : WORDS[input.locale].subject[input.kind];

// The text of one notification. Plain text, no markup: Telegram is sent without `parse_mode`.
export const messageFor = (input: MessageInput): Message => ({
  subject: subjectOf(input),
  text: input.audience === 'client' ? clientText(input) : staffText(input),
});
