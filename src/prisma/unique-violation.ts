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

// The model whose exclusion constraint refused the row (Postgres 23P01, which Prisma reports as
// P2039 «unknown database error»), or undefined. Not the constraint's name: the adapter gives no
// field for it here, and the message that names it is in the server's language (lc_messages).
// A table has at most one EXCLUDE (one_off_sessions_no_overlap; bookings' in E6), so the model
// tells which one; a second EXCLUDE on one table would need another way.
export function violatedExclusion(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const cause = (error.meta?.driverAdapterError as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code !== '23P01') return undefined;
  return typeof error.meta?.modelName === 'string' ? error.meta.modelName : undefined;
}
