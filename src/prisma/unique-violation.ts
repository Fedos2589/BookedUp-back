import { Prisma } from '../generated/prisma/client.js';

// The constraint behind a unique violation (P2002), by name. The pg driver adapter reports
// the index (`users_email_key`), not the columns, so callers map constraint names to the
// field they show — explicit, and it breaks loudly in tests if a constraint is renamed.
export function violatedUniqueConstraint(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return undefined;
  const cause = (error.meta?.driverAdapterError as { cause?: { constraint?: { index?: string } } } | undefined)?.cause;
  return cause?.constraint?.index;
}
