import { recipientsOf, type Member, type RecipientsContext, type RecipientsEvent } from './recipients.js';

const member = (userId: string, role: Member['role'], extra: Partial<Member> = {}): Member => ({
  userId,
  role,
  email: `${userId}@example.com`,
  locale: 'en',
  notifyEmail: true,
  notifyAllOnline: true,
  channels: [],
  ...extra,
});

const owner = member('owner', 'OWNER');
const admin = member('admin', 'ADMIN');
const master = member('master', 'MASTER');

const event = (extra: Partial<RecipientsEvent> = {}): RecipientsEvent => ({
  kind: 'BOOKED',
  actorUserId: null,
  channelId: null,
  ...extra,
});

const ctx = (extra: Partial<RecipientsContext> = {}): RecipientsContext => ({
  masterUserId: 'master',
  previousMasterUserId: null,
  members: [owner, admin, master],
  clientChannels: [],
  fallbackToLog: false,
  isOn: () => true,
  ...extra,
});

const staffOf = (event_: RecipientsEvent, ctx_: RecipientsContext) =>
  recipientsOf(event_, ctx_)
    .filter((r) => r.audience === 'staff')
    .map((r) => r.address)
    .sort();

describe('recipientsOf: staff', () => {
  it('the master who acted gets nothing', () => {
    expect(staffOf(event({ actorUserId: 'master' }), ctx())).toEqual([]);
  });

  it('an admin acting on a master’s booking → the master only', () => {
    expect(staffOf(event({ actorUserId: 'admin' }), ctx())).toEqual(['master@example.com']);
  });

  it('online → the master and the owner; an admin with the switch off is left out', () => {
    const members = [owner, member('admin', 'ADMIN', { notifyAllOnline: false }), master];
    expect(staffOf(event(), ctx({ members }))).toEqual(['master@example.com', 'owner@example.com']);
  });

  it('online → an admin with the switch on gets it too', () => {
    expect(staffOf(event(), ctx())).toEqual(['admin@example.com', 'master@example.com', 'owner@example.com']);
  });

  it('a cabinet booking by an admin never reaches the owner (notifyAllOnline is for online only)', () => {
    expect(staffOf(event({ actorUserId: 'admin' }), ctx())).not.toContain('owner@example.com');
  });

  it('a master who is also the owner gets one set', () => {
    const both = member('owner', 'OWNER');
    expect(staffOf(event(), ctx({ masterUserId: 'owner', members: [both, master] }))).toEqual(['owner@example.com']);
  });

  it('a master without an account → only the owner / admins online, nobody for a cabinet booking', () => {
    expect(staffOf(event(), ctx({ masterUserId: null }))).toEqual(['admin@example.com', 'owner@example.com']);
    expect(staffOf(event({ actorUserId: 'admin' }), ctx({ masterUserId: null }))).toEqual([]);
  });

  it('email off → only the linked channels', () => {
    const quiet = member('master', 'MASTER', {
      notifyEmail: false,
      channels: [{ kind: 'TELEGRAM', address: '555' }],
    });
    const recipients = recipientsOf(event({ actorUserId: 'admin' }), ctx({ members: [admin, quiet] }));
    expect(recipients).toEqual([{ channel: 'TELEGRAM', address: '555', audience: 'staff', locale: 'en' }]);
  });

  it('two push devices → two recipients, besides the email', () => {
    const phone = member('master', 'MASTER', {
      locale: 'ru',
      channels: [
        { kind: 'PUSH', address: 'https://push/1' },
        { kind: 'PUSH', address: 'https://push/2' },
      ],
    });
    const recipients = recipientsOf(event({ actorUserId: 'admin' }), ctx({ members: [admin, phone] }));
    expect(recipients.map((r) => [r.channel, r.address, r.locale])).toEqual([
      ['EMAIL', 'master@example.com', 'ru'],
      ['PUSH', 'https://push/1', 'ru'],
      ['PUSH', 'https://push/2', 'ru'],
    ]);
  });

  it('MOVED to another master → the previous master gets it too', () => {
    const previous = member('previous', 'MASTER');
    const members = [owner, master, previous];
    expect(
      staffOf(event({ kind: 'MOVED', actorUserId: 'owner' }), ctx({ members, previousMasterUserId: 'previous' })),
    ).toEqual(['master@example.com', 'previous@example.com']);
  });

  it('MOVED: the previous master who acted gets nothing', () => {
    const previous = member('previous', 'MASTER');
    const members = [master, previous];
    expect(
      staffOf(event({ kind: 'MOVED', actorUserId: 'previous' }), ctx({ members, previousMasterUserId: 'previous' })),
    ).toEqual(['master@example.com']);
  });

  it('REMINDER and CHANNEL_ON go to no staff', () => {
    expect(staffOf(event({ kind: 'REMINDER' }), ctx())).toEqual([]);
    expect(staffOf(event({ kind: 'CHANNEL_ON', channelId: 'c1' }), ctx())).toEqual([]);
  });

  it('a user who is not a member of the business gets nothing', () => {
    expect(staffOf(event({ actorUserId: 'admin' }), ctx({ masterUserId: 'stranger' }))).toEqual([]);
  });
});

describe('recipientsOf: client', () => {
  const tg = { id: 'c1', kind: 'TELEGRAM', address: '777', locale: 'ru' } as const;
  const push = { id: 'c2', kind: 'PUSH', address: 'https://push/c', locale: 'en' } as const;

  it.each(['BOOKED', 'MOVED', 'CANCELLED', 'REMINDER'] as const)('%s → every client channel', (kind) => {
    const clients = recipientsOf(event({ kind }), ctx({ members: [], masterUserId: null, clientChannels: [tg, push] }));
    expect(clients).toEqual([
      { channel: 'TELEGRAM', address: '777', audience: 'client', locale: 'ru' },
      { channel: 'PUSH', address: 'https://push/c', audience: 'client', locale: 'en' },
    ]);
  });

  it('CHANNEL_ON → the one channel just turned on', () => {
    const clients = recipientsOf(event({ kind: 'CHANNEL_ON', channelId: 'c2' }), ctx({ clientChannels: [tg, push] }));
    expect(clients).toEqual([{ channel: 'PUSH', address: 'https://push/c', audience: 'client', locale: 'en' }]);
  });
});

describe('recipientsOf: a kind that is not on', () => {
  const tgMember = member('master', 'MASTER', { channels: [{ kind: 'TELEGRAM', address: '555' }] });
  const email = { id: 'c1', kind: 'EMAIL', address: 'c@example.com', locale: 'en' } as const;
  const setup = (extra: Partial<RecipientsContext>) =>
    recipientsOf(
      event({ actorUserId: 'admin' }),
      ctx({ members: [admin, tgMember], clientChannels: [email], ...extra }),
    ).map((r) => [r.channel, r.address, r.audience]);

  it('with the fallback, goes to the log with the same address; a kind that is on stays', () => {
    expect(setup({ fallbackToLog: true, isOn: (kind) => kind === 'TELEGRAM' })).toEqual([
      ['LOG', 'master@example.com', 'staff'],
      ['TELEGRAM', '555', 'staff'],
      ['LOG', 'c@example.com', 'client'],
    ]);
  });

  it('without the fallback (production), is skipped; a kind that is on stays', () => {
    expect(setup({ fallbackToLog: false, isOn: (kind) => kind === 'TELEGRAM' })).toEqual([
      ['TELEGRAM', '555', 'staff'],
    ]);
  });
});
