import type { ChannelKind, MemberRole, NotificationKind } from '../generated/prisma/client.js';
import type { MessageLocale } from './messages.js';

export type Recipient = {
  channel: ChannelKind;
  address: string;
  audience: 'client' | 'staff';
  locale: MessageLocale;
};

export type RecipientsEvent = {
  kind: NotificationKind;
  // null = the client online or the system.
  actorUserId: string | null;
  // CHANNEL_ON: the client channel just turned on.
  channelId: string | null;
};

export type Member = {
  userId: string;
  role: MemberRole;
  email: string;
  locale: MessageLocale;
  notifyEmail: boolean;
  notifyAllOnline: boolean;
  channels: { kind: ChannelKind; address: string }[];
};

export type RecipientsContext = {
  // The booking's master's account, if they have one.
  masterUserId: string | null;
  // MOVED to another master: the previous master's account, otherwise null.
  previousMasterUserId: string | null;
  members: Member[];
  // The client channels that apply, already picked by the caller (not switched off; D4).
  clientChannels: { id: string; kind: ChannelKind; address: string; locale: MessageLocale }[];
  // Whether the kind has a real channel (it is configured).
  isOn: (kind: ChannelKind) => boolean;
  // A kind that is not on goes to the log (development, tests) or is skipped (production, D8).
  fallbackToLog: boolean;
};

export const STAFF_KINDS: readonly NotificationKind[] = ['BOOKED', 'MOVED', 'CANCELLED'];

// The accounts that hear about the event. The one who acted never hears about their own action.
const staffUserIds = (event: RecipientsEvent, ctx: RecipientsContext) => {
  if (!STAFF_KINDS.includes(event.kind)) return new Set<string>();
  const ids = new Set<string>();
  if (ctx.masterUserId !== null) ids.add(ctx.masterUserId);
  if (ctx.previousMasterUserId !== null) ids.add(ctx.previousMasterUserId);
  if (event.actorUserId === null) {
    for (const m of ctx.members) if (m.role !== 'MASTER' && m.notifyAllOnline) ids.add(m.userId);
  } else {
    ids.delete(event.actorUserId);
  }
  return ids;
};

const staffRecipients = (event: RecipientsEvent, ctx: RecipientsContext): Recipient[] => {
  const ids = staffUserIds(event, ctx);
  return ctx.members
    .filter((m) => ids.has(m.userId))
    .flatMap((m) =>
      [...(m.notifyEmail ? [{ kind: 'EMAIL' as const, address: m.email }] : []), ...m.channels]
        // WhatsApp sends client templates only: a member's number would fail every delivery.
        .filter((c) => c.kind !== 'WHATSAPP')
        .map((c) => ({
          channel: c.kind,
          address: c.address,
          audience: 'staff' as const,
          locale: m.locale,
        })),
    );
};

const clientRecipients = (event: RecipientsEvent, ctx: RecipientsContext): Recipient[] =>
  ctx.clientChannels
    .filter((c) => event.kind !== 'CHANNEL_ON' || c.id === event.channelId)
    .map((c) => ({ channel: c.kind, address: c.address, audience: 'client', locale: c.locale }));

export const recipientsOf = (event: RecipientsEvent, ctx: RecipientsContext): Recipient[] => {
  return [...staffRecipients(event, ctx), ...clientRecipients(event, ctx)].flatMap((r) => {
    if (ctx.isOn(r.channel)) return [r];
    return ctx.fallbackToLog ? [{ ...r, channel: 'LOG' as const }] : [];
  });
};
