export type MasterLoad = { staffId: string; name: string; bookings: number };

// Names are compared by one fixed collation, not the server's locale.
const byName = new Intl.Collator('ru');

// Who is offered a visitor's «any master» first: the one with the fewest bookings that hold time that day,
// then by name, then by id (so the order never depends on how the database returned them).
export const orderMasters = (masters: readonly MasterLoad[]): string[] =>
  [...masters]
    .sort(
      (a, b) =>
        a.bookings - b.bookings ||
        byName.compare(a.name, b.name) ||
        (a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0),
    )
    .map(({ staffId }) => staffId);
