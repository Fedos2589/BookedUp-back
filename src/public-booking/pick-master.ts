export type MasterLoad = { staffId: string; name: string; bookings: number };

// Who is offered a visitor's «any master» first: the one with the fewest live bookings that day,
// then by name, then by id (so the order never depends on how the database returned them).
export const orderMasters = (masters: readonly MasterLoad[]): string[] =>
  [...masters]
    .sort(
      (a, b) =>
        a.bookings - b.bookings ||
        a.name.localeCompare(b.name) ||
        (a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0),
    )
    .map(({ staffId }) => staffId);
