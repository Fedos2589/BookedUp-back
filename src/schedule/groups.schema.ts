import { z } from 'zod';

import { localDate } from './schedule.schema.js';

// For a check across fields: zod 4 runs an object's refine even when a field failed, so without
// this the check would see raw input (see schedule.schema.ts).
const whenFieldsValid = { when: (payload: { issues: readonly unknown[] }) => payload.issues.length === 0 };

const title = z.string().trim().min(1).max(100);
// What it is, how to get ready, what to bring. Plain text; blank means none.
const description = z
  .string()
  .trim()
  .max(2000)
  .nullish()
  .transform((value) => value || null);
const capacity = z.int().min(1).max(1000).describe('How many people it is for');
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const weekday = z.int().min(1).max(7);

export const groupSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  weekdays: z.array(weekday).describe('ISO: 1 is Monday, 7 is Sunday; ascending'),
  startMinute: z.int().min(0).max(1439).describe("Minutes after midnight on the business's clock"),
  durationMinutes: z.int().min(1).max(1440),
  capacity,
  cancellations: z.array(localDate).describe('Dates it does not meet, from today on'),
});
export type GroupDto = z.infer<typeof groupSchema>;

export const groupInput = z.object({
  title,
  description,
  // Deduplicated and in order, so the stored list never depends on how the form sent it.
  weekdays: z
    .array(weekday)
    .min(1)
    .max(7)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  startMinute: z.int().min(0).max(1439),
  durationMinutes: z.int().min(1).max(1440),
  capacity,
});
export type GroupInput = z.infer<typeof groupInput>;

export const oneOffSessionSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  capacity,
});
export type OneOffSessionDto = z.infer<typeof oneOffSessionSchema>;

const DAY_MS = 24 * 60 * 60_000;

export const oneOffSessionInput = z
  .object({ title, description, startsAt: instant, endsAt: instant, capacity })
  .refine((session) => session.startsAt < session.endsAt, {
    path: ['endsAt'],
    message: 'Not after startsAt',
    ...whenFieldsValid,
  })
  .refine((session) => session.endsAt.getTime() - session.startsAt.getTime() <= DAY_MS, {
    path: ['endsAt'],
    message: 'At most a day after startsAt',
    ...whenFieldsValid,
  });
export type OneOffSessionInput = z.infer<typeof oneOffSessionInput>;

const conflict = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group'), id: z.uuid(), title: z.string(), date: localDate.nullable() }),
  z.object({ kind: z.literal('oneOffSession'), id: z.uuid(), title: z.string(), startsAt: z.iso.datetime() }),
]);

// 409 in groups mode: a master runs one group or session at a time. `conflictsWith` is what the
// change would overlap; `field` is the form field to highlight.
export const scheduleConflictSchema = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: z.string(),
  field: z.enum(['startMinute', 'startsAt', 'date']),
  conflictsWith: conflict,
});
export type ScheduleConflict = z.infer<typeof scheduleConflictSchema>;
