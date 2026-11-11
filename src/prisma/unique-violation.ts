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
