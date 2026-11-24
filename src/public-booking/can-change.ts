// A booking the booker may still cancel or move, or connect a channel to: BOOKED or CONFIRMED and not started.
export const canChange = ({ status, startsAt }: { status: string; startsAt: Date }, now: Date) =>
  (status === 'BOOKED' || status === 'CONFIRMED') && startsAt > now;
