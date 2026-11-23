import { z } from 'zod';

import { ScheduleMode } from '../generated/prisma/enums.js';

// What a visitor sees of a business: its name and zone, and the masters they can book. Nothing
// about clients.
export const publicBusinessSchema = z.object({
  name: z.string(),
  slug: z.string(),
  timeZone: z.string(),
  masters: z.array(z.object({ id: z.uuid(), name: z.string(), scheduleMode: z.enum(ScheduleMode) })),
});
export type PublicBusinessDto = z.infer<typeof publicBusinessSchema>;
