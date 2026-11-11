import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

const week = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);

describe('invitations in the database', () => {
  it('never invites an owner', async () => {
    const owner = await signUpOwner(app);

    await expect(
      prisma.invitation.create({
        data: { businessId: owner.business.id, role: 'OWNER', tokenHash: randomUUID(), expiresAt: week() },
      }),
    ).rejects.toThrow(/invitations_role_not_owner/);
  });

  it('is never both accepted and revoked', async () => {
    const owner = await signUpOwner(app);

    await expect(
      prisma.invitation.create({
        data: {
          businessId: owner.business.id,
          role: 'MASTER',
          tokenHash: randomUUID(),
          expiresAt: week(),
          acceptedAt: new Date(),
          revokedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/invitations_one_end/);
  });

  it('links only a schedule of the same business', async () => {
    const owner = await signUpOwner(app);
    const other = await signUpOwner(app);
    const theirs = await prisma.staff.create({ data: { businessId: other.business.id, name: 'X' } });

    await expect(
      prisma.invitation.create({
        data: {
          businessId: owner.business.id,
          role: 'MASTER',
          tokenHash: randomUUID(),
          expiresAt: week(),
          staffId: theirs.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
