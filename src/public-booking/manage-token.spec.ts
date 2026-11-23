import { manageLink } from './manage-token.js';

describe('the manage link', () => {
  it('puts the token under /book/<slug>/manage on the front', () => {
    expect(manageLink('http://localhost:5173', 'studio', 'abc')).toBe('http://localhost:5173/book/studio/manage/abc');
  });

  // A front served under a path keeps it, with or without a trailing slash.
  it("keeps the front's own path", () => {
    expect(manageLink('https://x.com/app', 'studio', 'abc')).toBe('https://x.com/app/book/studio/manage/abc');
    expect(manageLink('https://x.com/app/', 'studio', 'abc')).toBe('https://x.com/app/book/studio/manage/abc');
  });
});
