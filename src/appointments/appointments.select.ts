// What a booking is answered with (appointmentSchema); shared with the client's booking history.
export const appointmentSelect = {
  id: true,
  staffId: true,
  clientId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  clientName: true,
  clientPhone: true,
  note: true,
  groupId: true,
  oneOffSessionId: true,
} as const;
