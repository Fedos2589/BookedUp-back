import type { MemberRole } from '../generated/prisma/enums.js';

// Whose place in the team each role may give, change or take away: invite to, move to or from,
// remove. Nobody manages the owner: ownership is handed over (both sides in one transaction),
// never edited like a role. The one table to read and change; the front reads the role from /me.
const manages: Record<MemberRole, readonly MemberRole[]> = {
  OWNER: ['ADMIN', 'MASTER'],
  ADMIN: ['MASTER'],
  MASTER: [],
};

export const roleManages = (role: MemberRole, target: MemberRole): boolean => manages[role].includes(target);

// What each role may do inside its business, beyond being a member. BusinessPolicy turns each
// ability into a route check.
const abilities = {
  // The team pages: staff, members, invitations. Which of them a role may touch is roleManages.
  manageTeam: (role: MemberRole) => manages[role].length > 0,
} as const satisfies Record<string, (role: MemberRole) => boolean>;

export type BusinessAbility = keyof typeof abilities;

export const roleCan = (role: MemberRole, ability: BusinessAbility): boolean => abilities[ability](role);
