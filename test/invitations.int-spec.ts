import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { memberOf, signUpOwner } from './helpers.js';
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

const http = () => request(app.getHttpServer());
const invitationsUrl = (businessId: string) => `/businesses/${businessId}/invitations`;

type Owner = Awaited<ReturnType<typeof signUpOwner>>;

const invite = (owner: Pick<Owner, 'cookie'> & { businessId: string }, body: object) =>
  http().post(invitationsUrl(owner.businessId)).set('Cookie', owner.cookie).send(body);

const pending = async (owner: Owner) =>
  (await http().get(invitationsUrl(owner.business.id)).set('Cookie', owner.cookie).expect(200)).body as {
    id: string;
  }[];

// The token is the last segment of the link the API hands out.
const tokenOf = (link: string) => new URL(link).pathname.split('/').pop()!;

describe('inviting someone', () => {
  it('answers a one-time link to the front, and lists the invitation as pending', async () => {
    const owner = await signUpOwner(app);

    const res = await invite({ ...owner, businessId: owner.business.id }, { role: 'MASTER', note: ' Anna ' }).expect(
      201,
    );

    expect(res.body.link).toMatch(/^http:\/\/localhost:5173\/invite\/[\w-]{43}$/);
    expect(res.body.invitation).toEqual({
      id: expect.any(String),
      role: 'MASTER',
      note: 'Anna',
      staffId: null,
      invitedBy: 'Lena',
      expiresAt: expect.any(String),
      createdAt: expect.any(String),
    });
    const days = (Date.parse(res.body.invitation.expiresAt) - Date.now()) / (24 * 3600 * 1000);
    expect(days).toBeCloseTo(7, 1);
    expect(await pending(owner)).toEqual([res.body.invitation]);
  });

  // Only a hash is kept, like sessions: a database leak gives no working links.
  it('keeps no token in the database', async () => {
    const owner = await signUpOwner(app);
    const { body } = await invite({ ...owner, businessId: owner.business.id }, { role: 'MASTER' }).expect(201);

    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: body.invitation.id } });
    expect(row.tokenHash).not.toContain(tokenOf(body.link));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets an admin invite masters, not admins; a master invites no one', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const businessId = owner.business.id;

    await invite({ ...admin, businessId }, { role: 'MASTER' }).expect(201);
    await invite({ ...admin, businessId }, { role: 'ADMIN' }).expect(403);
    await invite({ ...master, businessId }, { role: 'MASTER' }).expect(403);
    await invite({ ...owner, businessId }, { role: 'ADMIN' }).expect(201);
    await invite({ ...owner, businessId }, { role: 'OWNER' }).expect(400);
    expect(await prisma.invitation.count({ where: { businessId } })).toBe(2);
  });

  it("offers a schedule without an account, only this business's and not archived", async () => {
    const owner = await signUpOwner(app);
    const other = await signUpOwner(app);
    const businessId = owner.business.id;
    const free = await prisma.staff.create({ data: { businessId, name: 'Anna' } });
    const archived = await prisma.staff.create({ data: { businessId, name: 'Gone', archivedAt: new Date() } });
    const master = await memberOf(app, businessId, 'MASTER');
    const linked = await prisma.staff.create({ data: { businessId, name: 'Taken', userId: master.userId } });
    const theirs = await prisma.staff.create({ data: { businessId: other.business.id, name: 'Theirs' } });

    const res = await invite({ ...owner, businessId }, { role: 'MASTER', staffId: free.id }).expect(201);
    expect(res.body.invitation).toMatchObject({ staffId: free.id });
    for (const staff of [archived, linked, theirs]) {
      const refused = await invite({ ...owner, businessId }, { role: 'MASTER', staffId: staff.id }).expect(400);
      expect(refused.body.message).toEqual(['staffId: Not a schedule without an account in this business']);
    }
  });
});

describe('pending invitations', () => {
  it("leaves out the revoked and the expired, and other businesses' ", async () => {
    const owner = await signUpOwner(app);
    const other = await signUpOwner(app);
    const businessId = owner.business.id;
    const kept = (await invite({ ...owner, businessId }, { role: 'MASTER' })).body.invitation;
    const revoked = (await invite({ ...owner, businessId }, { role: 'MASTER' })).body.invitation;
    const expired = (await invite({ ...owner, businessId }, { role: 'MASTER' })).body.invitation;
    await invite({ ...other, businessId: other.business.id }, { role: 'MASTER' }).expect(201);
    await http()
      .delete(`${invitationsUrl(businessId)}/${revoked.id}`)
      .set('Cookie', owner.cookie)
      .expect(204);
    await prisma.invitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await pending(owner)).toEqual([kept]);
  });

  it('is for the owner and admins, not masters', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(app, owner.business.id, 'MASTER');

    await http().get(invitationsUrl(owner.business.id)).set('Cookie', master.cookie).expect(403);
  });
});

describe('revoking an invitation', () => {
  it('is idempotent', async () => {
    const owner = await signUpOwner(app);
    const { body } = await invite({ ...owner, businessId: owner.business.id }, { role: 'MASTER' });
    const url = `${invitationsUrl(owner.business.id)}/${body.invitation.id}`;

    await http().delete(url).set('Cookie', owner.cookie).expect(204);
    await http().delete(url).set('Cookie', owner.cookie).expect(204);
  });

  it("keeps an admin from revoking an admin's invitation", async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const { body } = await invite({ ...owner, businessId: owner.business.id }, { role: 'ADMIN' });

    await http()
      .delete(`${invitationsUrl(owner.business.id)}/${body.invitation.id}`)
      .set('Cookie', admin.cookie)
      .expect(403);
    expect(await pending(owner)).toHaveLength(1);
  });

  it("answers 404 to another business's invitation, and leaves it", async () => {
    const owner = await signUpOwner(app);
    const other = await signUpOwner(app);
    const { body } = await invite({ ...other, businessId: other.business.id }, { role: 'MASTER' });

    await http()
      .delete(`${invitationsUrl(owner.business.id)}/${body.invitation.id}`)
      .set('Cookie', owner.cookie)
      .expect(404);
    expect(await pending(other)).toHaveLength(1);
  });
});

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
