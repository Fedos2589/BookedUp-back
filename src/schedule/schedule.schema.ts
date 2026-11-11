import { z } from 'zod';

import { conflictErrorSchema } from '../common/api-errors.js';
import { addDays } from './local-time.js';
import { firstOverlap } from './weekly-overlap.js';

// What a window is for («Football»); blank means nothing.
const title = z
  .string()
  .trim()
  .max(100)
  .nullish()
  .transform((value) => value || null);

// For a check across fields: zod 4 runs an object's refine even when a field failed (the parse
// goes on to collect every issue), so without this the check sees a raw string — 500, not 400.
const whenFieldsValid = { when: (payload: { issues: readonly unknown[] }) => payload.issues.length === 0 };

const slotMinutes = z.int().min(5).max(1440);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const weeklyWindowSchema = z.object({
  weekday: z.int().min(1).max(7).describe('ISO: 1 is Monday, 7 is Sunday'),
  startMinute: z.int().min(0).max(1439).describe("Minutes after midnight on the business's clock"),
  durationMinutes: z.int().min(1).max(1440),
  slotMinutes,
  title: z.string().nullable(),
});

const weeklyWindowInput = weeklyWindowSchema
  .extend({ title })
  .refine((window) => window.slotMinutes <= window.durationMinutes, {
    path: ['slotMinutes'],
    message: 'Longer than the window',
    ...whenFieldsValid,
  });

export const weeklyScheduleSchema = z.object({ windows: z.array(weeklyWindowSchema) });
export type WeeklySchedule = z.infer<typeof weeklyScheduleSchema>;

export const weeklyScheduleInput = z
  .object({ windows: z.array(weeklyWindowInput).max(100) })
  .superRefine(({ windows }, ctx) => {
    const overlap = firstOverlap(windows);
    if (overlap)
      ctx.addIssue({ code: 'custom', path: ['windows', overlap[1]], message: `Overlaps windows.${overlap[0]}` });
  });
export type WeeklyScheduleInput = z.infer<typeof weeklyScheduleInput>;

const DAY_MS = 24 * 60 * 60_000;

export const oneOffWindowSchema = z.object({
  id: z.uuid(),
  staffId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  slotMinutes,
  title: z.string().nullable(),
});
export type OneOffWindowDto = z.infer<typeof oneOffWindowSchema>;

export const oneOffWindowInput = z
  .object({ startsAt: instant, endsAt: instant, slotMinutes, title })
  .refine((window) => window.endsAt.getTime() - window.startsAt.getTime() <= DAY_MS, {
    path: ['endsAt'],
    message: 'At most a day after startsAt',
    ...whenFieldsValid,
  })
  .refine((window) => window.startsAt.getTime() + window.slotMinutes * 60_000 <= window.endsAt.getTime(), {
    path: ['slotMinutes'],
    message: 'Longer than the window',
    ...whenFieldsValid,
  });
export type OneOffWindowInput = z.infer<typeof oneOffWindowInput>;

export const oneOffConflictSchema = conflictErrorSchema(['startsAt']);
export type OneOffConflict = z.infer<typeof oneOffConflictSchema>;

export const timeOffSchema = z.object({
  id: z.uuid(),
  staffId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  note: z.string().nullable(),
});
export type TimeOffDto = z.infer<typeof timeOffSchema>;

export const timeOffInput = z
  .object({
    startsAt: instant,
    endsAt: instant,
    note: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((value) => value || null),
  })
  .refine((timeOff) => timeOff.startsAt < timeOff.endsAt, {
    path: ['endsAt'],
    message: 'Not after startsAt',
    ...whenFieldsValid,
  });
export type TimeOffInput = z.infer<typeof timeOffInput>;

export const slotSchema = z.object({
  staffId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  title: z.string().nullable(),
});
export type SlotDto = z.infer<typeof slotSchema>;

const MAX_DAYS = 31;

// Days on the business's clock, both included.
export const slotsQuery = z
  .object({ from: z.iso.date(), to: z.iso.date(), staffId: z.uuid().optional() })
  .refine(({ from, to }) => from <= to, { path: ['to'], message: 'Before from', ...whenFieldsValid })
  .refine(({ from, to }) => to < addDays(from, MAX_DAYS), {
    path: ['to'],
    message: `More than ${MAX_DAYS} days after from`,
    ...whenFieldsValid,
  });
export type SlotsQuery = z.infer<typeof slotsQuery>;
