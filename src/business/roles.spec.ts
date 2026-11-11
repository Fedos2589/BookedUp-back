import { roleCan } from './roles.js';

describe('what each role may do in a business', () => {
  it('lets the owner and admins manage staff, not masters', () => {
    expect(roleCan('OWNER', 'manageStaff')).toBe(true);
    expect(roleCan('ADMIN', 'manageStaff')).toBe(true);
    expect(roleCan('MASTER', 'manageStaff')).toBe(false);
  });
});
