import type { AuthenticationStorage, SessionRecord, SessionStore } from '@nestjs/authentication';
import { authenticationStoreContract } from '@nestjs/authentication/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';

import { PrismaSessionStore } from '../src/auth/prisma-session.store.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

// A pool, so the concurrent cases really race.
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: inject('databaseUrl'), max: 10 }) });
const ignoreRegistration = { registerSource() {} } as unknown as AuthenticationStorage;

afterAll(async () => {
  await prisma.$disconnect();
});

// The suite invents user ids (`user-<uuid>`), but sessions.user_id is a foreign key to
// users. Each invented id gets a real user, created on first use, and records read back
// carry the invented id again.
function withRealUsers(store: SessionStore): SessionStore {
  const realIds = new Map<string, Promise<string>>();
  const invented = new Map<string, string>();
  const real = (userId: string) => {
    let id = realIds.get(userId);
    if (!id) {
      id = prisma.user
        .create({ data: { email: `${randomUUID()}@contract.test`, name: 'Contract' } })
        .then((user) => (invented.set(user.id, userId), user.id));
      realIds.set(userId, id);
    }
    return id;
  };
  const back = (record: SessionRecord): SessionRecord => ({ ...record, userId: invented.get(record.userId)! });

  return {
    getSession: async (id) => {
      const record = await store.getSession(id);
      return record && back(record);
    },
    createSession: async (record) => store.createSession({ ...record, userId: await real(record.userId) }),
    touchSession: (id, at) => store.touchSession(id, at),
    deleteSession: (id) => store.deleteSession(id),
    listUserSessions: async (userId) => (await store.listUserSessions(await real(userId))).map(back),
    deleteUserSessions: async (userId) => store.deleteUserSessions(await real(userId)),
  };
}

describe('PrismaSessionStore keeps the @nestjs/authentication session contract', () => {
  const cases = authenticationStoreContract(
    () => ({
      sessions: withRealUsers(new PrismaSessionStore(prisma as PrismaService, ignoreRegistration)),
    }),
    { contracts: ['sessions'], concurrent: true },
  );

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, contractCase) => {
    await contractCase.run();
  });
});

describe('PrismaSessionStore', () => {
  it('reads the user with the session, so a request with a cookie costs one query', async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, name: 'Lena' } });
    const store = new PrismaSessionStore(prisma as PrismaService, ignoreRegistration);
    const now = new Date();
    const expiresAt = new Date(+now + 60_000);
    await store.createSession({ id: randomUUID(), userId: user.id, createdAt: now, expiresAt, lastActiveAt: now });

    const [created] = await store.listUserSessions(user.id);
    const session = await store.getSession(created.id);

    expect(session?.extra).toEqual({ id: user.id, email: user.email, name: 'Lena' });
  });
});
