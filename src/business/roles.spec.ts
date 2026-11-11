import { roleCan, roleManages } from './roles.js';

describe('what each role may do in a business', () => {
  it('lets the owner and admins manage the team, not masters', () => {
    expect(roleCan('OWNER', 'manageTeam')).toBe(true);
    expect(roleCan('ADMIN', 'manageTeam')).toBe(true);
    expect(roleCan('MASTER', 'manageTeam')).toBe(false);
  });

  // Invite, change the role of, remove.
  it('lets the owner manage admins and masters, and admins only masters', () => {
    expect(roleManages('OWNER', 'ADMIN')).toBe(true);
    expect(roleManages('OWNER', 'MASTER')).toBe(true);
    expect(roleManages('ADMIN', 'MASTER')).toBe(true);
    expect(roleManages('ADMIN', 'ADMIN')).toBe(false);
    expect(roleManages('MASTER', 'MASTER')).toBe(false);
  });

  // Ownership is handed over (both sides in one transaction), never edited like a role.
  it('lets nobody manage the owner', () => {
    expect(roleManages('OWNER', 'OWNER')).toBe(false);
    expect(roleManages('ADMIN', 'OWNER')).toBe(false);
  });
});
