import { z } from 'zod';

// Where this browser's login stands. `confirmed`: the session cookie is set by this very answer.
export const clientLoginStatusSchema = z.object({ status: z.enum(['pending', 'confirmed', 'expired']) });
export type ClientLoginStatusDto = z.infer<typeof clientLoginStatusSchema>;
