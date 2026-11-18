import { z } from 'zod';

import { appointmentSchema } from '../appointments/appointments.schema.js';

export const clientAppointmentsPageSchema = z.object({
  items: z.array(appointmentSchema),
  total: z.number().int().describe('All bookings of the client you may see, not just this page'),
});
export type ClientAppointmentsPageDto = z.infer<typeof clientAppointmentsPageSchema>;
