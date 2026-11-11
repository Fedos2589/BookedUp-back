import { z } from 'zod';

import { assignableRoleSchema } from '../members/members.schema.js';

// An invitation as the team page lists it. The token is not here: it exists only in the link
// handed out once, when the invitation is created.
export const invitationSchema = z.object({
  id: z.uuid(),
  role: assignableRoleSchema,
  note: z.string().nullable(),
  staffId: z.uuid().nullable(),
  // The inviter's name; null when that account is gone.
  invitedBy: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export type InvitationView = z.infer<typeof invitationSchema>;

export const createInvitationSchema = z.object({
  role: assignableRoleSchema,
  note: z.string().trim().min(1).max(100).optional(),
  // A schedule without an account, to link to whoever accepts.
  staffId: z.uuid().optional(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const createdInvitationSchema = z.object({
  invitation: invitationSchema,
  // <APP_URL>/invite/<token>. Shown once: only the token's hash is kept.
  link: z.url(),
});

export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;
