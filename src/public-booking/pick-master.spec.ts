import { orderMasters } from './pick-master.js';

describe('orderMasters', () => {
  it('puts the master with fewer bookings that day first, then by name, then by id', () => {
    const order = orderMasters([
      { staffId: 'a', name: 'Zoe', bookings: 0 },
      { staffId: 'b', name: 'Adam', bookings: 2 },
      { staffId: 'c', name: 'Mia', bookings: 0 },
      { staffId: 'e', name: 'Mia', bookings: 0 },
      { staffId: 'd', name: 'Bob', bookings: 1 },
    ]);
    expect(order).toEqual(['c', 'e', 'a', 'd', 'b']);
  });

  it('does not change what it is given', () => {
    const given = [
      { staffId: 'a', name: 'Zoe', bookings: 1 },
      { staffId: 'b', name: 'Adam', bookings: 0 },
    ];
    orderMasters(given);
    expect(given.map((each) => each.staffId)).toEqual(['a', 'b']);
  });
});
