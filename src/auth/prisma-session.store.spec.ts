import type { AuthenticationStorage } from '@nestjs/authentication';

import type { PrismaService } from '../prisma/prisma.service.js';
import { PrismaSessionStore } from './prisma-session.store.js';

describe('PrismaSessionStore.createSession', () => {
  // SignInService sets the cookie only after createSession() resolves: a failed sweep of
  // other people's expired sessions must not turn a correct password into a 500.
  it('keeps the new session when sweeping expired ones fails', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = {
      session: { create, deleteMany: vi.fn().mockRejectedValue(new Error('lock timeout')) },
    } as unknown as PrismaService;
    const store = new PrismaSessionStore(prisma, { registerSource() {} } as unknown as AuthenticationStorage);
    const now = new Date();

    await expect(
      store.createSession({ id: 'sha', userId: 'u', createdAt: now, expiresAt: now, lastActiveAt: now }),
    ).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
  });
});
