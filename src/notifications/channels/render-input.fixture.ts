import type { RenderInput } from './channel.js';

// A client's «booking confirmed» in English; a spec overrides what it is about.
export const renderInput = (overrides: Partial<RenderInput> = {}): RenderInput => ({
  kind: 'BOOKED',
  audience: 'client',
  locale: 'en',
  businessName: 'Studio',
  masterName: 'Anna',
  title: null,
  startsAt: new Date('2026-11-27T10:00:00Z'),
  timeZone: 'UTC',
  clientName: 'Ivan',
  url: 'https://app.example.com/book/studio',
  ...overrides,
});
