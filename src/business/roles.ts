import type { MemberRole } from '../generated/prisma/enums.js';

// What each role may do inside its business, beyond being a member. The one table to read and
// change: BusinessPolicy turns each ability into a check, and the front reads the role from /me.
const abilities = {
  manageStaff: ['OWNER', 'ADMIN'],
} as const satisfies Record<string, readonly MemberRole[]>;

export type BusinessAbility = keyof typeof abilities;

export const roleCan = (role: MemberRole, ability: BusinessAbility): boolean =>
  (abilities[ability] as readonly MemberRole[]).includes(role);
