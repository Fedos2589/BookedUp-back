import { invitationLink } from './invitation-token.js';

describe('the invitation link', () => {
  it('puts the token under /invite on the front', () => {
    expect(invitationLink('http://localhost:5173', 'abc')).toBe('http://localhost:5173/invite/abc');
  });

  // A front served under a path keeps it, with or without a trailing slash.
  it("keeps the front's own path", () => {
    expect(invitationLink('https://x.com/app', 'abc')).toBe('https://x.com/app/invite/abc');
    expect(invitationLink('https://x.com/app/', 'abc')).toBe('https://x.com/app/invite/abc');
  });
});
