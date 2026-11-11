import { z } from 'zod';

import { MemberRole } from '../generated/prisma/enums.js';

// Someone who signs in to the business, as the team page shows them. `staffId` is their
// schedule, if they take clients.
export const memberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: z.enum(MemberRole),
  staffId: z.uuid().nullable(),
});

export type Member = z.infer<typeof memberSchema>;

// The roles a member can be given. Owner is not one: ownership is handed over, not assigned.
export const assignableRoleSchema = z.enum([MemberRole.ADMIN, MemberRole.MASTER]);

export const changeRoleSchema = z.object({ role: assignableRoleSchema });
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
