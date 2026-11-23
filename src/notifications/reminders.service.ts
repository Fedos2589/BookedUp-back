import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// How far back a reminder time may lie and still be written: a run that was late (a restart) catches up,
// a booking whose reminder time went by long ago gets nothing.
const WINDOW_MINUTES = 15;

@Injectable()
export class RemindersService {
  constructor(private readonly prisma: PrismaService) {}

  // Writes a REMINDER event for every booking whose reminder time (`starts_at - offset`) fell into the last
  // WINDOW_MINUTES. One statement for all businesses: the reminders are one queue, like the outbox, so this
  // scan crosses businesses by design; each event gets its own booking's business_id.
  // The unique index `notification_events_reminder_once` (booking, offset, start) makes a second run, or two
  // runs at once, write nothing. A booking made after its reminder time gets none; a moved one has a new
  // `starts_at`, so it has a new key (its `created_at` stays the first one, which is right).
  // Returns how many events it wrote.
  async scheduleReminders(now: Date): Promise<number> {
    return this.prisma.$executeRaw`
      INSERT INTO notification_events (business_id, appointment_id, kind, starts_at, offset_minutes)
      SELECT a.business_id, a.id, 'REMINDER', a.starts_at, o.minutes
      FROM businesses b
      CROSS JOIN LATERAL unnest(b.reminder_offsets) AS o(minutes)
      JOIN appointments a ON a.business_id = b.id
      CROSS JOIN LATERAL (SELECT a.starts_at - make_interval(mins => o.minutes) AS at) due
      WHERE a.status = 'BOOKED'
        AND a.starts_at > ${now}::timestamptz
        AND due.at <= ${now}::timestamptz
        AND due.at > ${now}::timestamptz - make_interval(mins => ${WINDOW_MINUTES})
        AND a.created_at <= due.at
      ON CONFLICT DO NOTHING`;
  }
}
