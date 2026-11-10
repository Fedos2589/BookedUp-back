import { accountEmail } from './account-email.js';

describe('accountEmail', () => {
  it('spells the address as sign-in looks it up', () => {
    expect(accountEmail({ body: { email: '  Lena@Example.COM ' } })).toBe('lena@example.com');
  });

  it.each([undefined, 42, 'not-an-email', 'a'.repeat(300) + '@example.com'])('is empty for %j', (email) => {
    expect(accountEmail({ body: { email } })).toBe('');
  });

  it('is empty without a body', () => {
    expect(accountEmail({})).toBe('');
  });
});
