import { Prisma } from '../generated/prisma/client.js';

// The constraint behind a unique violation (P2002), by name. The pg driver adapter reports
// the index (`users_email_key`), not the columns, so callers map constraint names to the
// field they show — explicit, and it breaks loudly in tests if a constraint is renamed.
export const violatedUniqueConstraint = (error: unknown) => violatedConstraint(error, 'P2002');

// The same for a foreign key (P2003): `staff_user_id_business_id_fkey`.
export const violatedForeignKey = (error: unknown) => violatedConstraint(error, 'P2003');

function violatedConstraint(error: unknown, code: 'P2002' | 'P2003'): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== code) return undefined;
  const cause = (error.meta?.driverAdapterError as { cause?: { constraint?: { index?: string } } } | undefined)?.cause;
  return cause?.constraint?.index;
}

// The constraint behind an exclusion violation (Postgres 23P01, Prisma P2039 «unknown database
// error»): `one_off_windows_no_overlap`. The adapter gives no constraint field for it, only the
// message, which names it.
export function violatedExclusion(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const cause = (error.meta?.driverAdapterError as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  if (cause?.code !== '23P01') return undefined;
  return /exclusion constraint "([^"]+)"/.exec(cause.message ?? '')?.[1];
}
