import { z } from 'zod';

import { conflictErrorSchema } from '../common/api-errors.js';

// A schedule column as the API answers it. `userId` is the member behind it, null for a
// master without an account.
export const staffSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  userId: z.uuid().nullable(),
  archived: z.boolean(),
  scheduleMode: z.enum(['HOURS', 'GROUPS']).describe('Hours cut into one-person slots, or groups'),
});

export type StaffMember = z.infer<typeof staffSchema>;

const name = z.string().trim().min(1).max(100);

export const createStaffSchema = z.object({ name, userId: z.uuid().optional() });
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z.object({ name: name.optional(), archived: z.boolean().optional() });
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

export const staffConflictSchema = conflictErrorSchema(['userId']);
export type StaffConflict = z.infer<typeof staffConflictSchema>;
