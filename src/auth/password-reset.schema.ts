import { z } from 'zod';

import { emailSchema } from './credentials.schema.js';

export const passwordResetRequestSchema = z.object({ email: emailSchema });

export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;
