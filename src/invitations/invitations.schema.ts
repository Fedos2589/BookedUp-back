import { z } from 'zod';

import { signUpSchema } from '../auth/sign-up.schema.js';
import { memberBusinessSchema } from '../business/business.schema.js';
import { conflictErrorSchema } from '../common/api-errors.js';
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

// The token as it arrives in the path. Any string up to a sane length: one that was never
// handed out is simply not found.
export const invitationTokenSchema = z.string().min(1).max(64);

// What the link's page shows before anyone signs in or up.
export const invitationPreviewSchema = z.object({
  businessName: z.string(),
  role: assignableRoleSchema,
  invitedBy: z.string().nullable(),
});

export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

// The account part of sign-up, under the same rules.
export const invitationSignUpSchema = signUpSchema.pick({ email: true, password: true, name: true });
export type InvitationSignUpInput = z.infer<typeof invitationSignUpSchema>;

export const invitationSignUpResultSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.email(), name: z.string() }),
  business: memberBusinessSchema,
});

export type InvitationSignUpResult = z.infer<typeof invitationSignUpResultSchema>;

export const invitationSignUpConflictSchema = conflictErrorSchema(['email']);
export type InvitationSignUpConflict = z.infer<typeof invitationSignUpConflictSchema>;
