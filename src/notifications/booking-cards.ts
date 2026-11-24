// The client cards a booking reaches: the client's own, and their guardian's when they have one. A WhatsApp
// number sits on one of them (E9, decision 4), and the dispatcher and the routes read them the same way.
export const cardsOf = ({ clientId, client }: { clientId: string; client: { guardianId: string | null } }): string[] =>
  client.guardianId === null ? [clientId] : [clientId, client.guardianId];
