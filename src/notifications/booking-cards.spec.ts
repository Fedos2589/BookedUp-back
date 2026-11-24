import { cardsOf } from './booking-cards.js';

describe('cardsOf', () => {
  it('is the client alone, or the client and their guardian', () => {
    expect(cardsOf({ clientId: 'kid', client: { guardianId: null } })).toEqual(['kid']);
    expect(cardsOf({ clientId: 'kid', client: { guardianId: 'parent' } })).toEqual(['kid', 'parent']);
  });
});
