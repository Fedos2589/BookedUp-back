import { AuthorizationService } from '@nestjs/authorization';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { memberOf, signUpOwner, userIdOf } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

const http = () => request(app.getHttpServer());
const membersUrl = (businessId: string) => `/businesses/${businessId}/members`;
const memberUrl = (businessId: string, userId: string) => `${membersUrl(businessId)}/${userId}`;

const roleIn = async (businessId: string, userId: string) =>
  (await prisma.membership.findUnique({ where: { userId_businessId: { userId, businessId } } }))?.role ?? null;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

describe('the members of a business', () => {
  it('lists who signs in, with their role and schedule, in the order they joined', async () => {
    const owner = await signUpOwner(app);
    const ownerId = await userIdOf(app, owner.cookie);
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const schedule = await prisma.staff.create({
      data: { businessId: owner.business.id, name: 'M', userId: master.userId },
    });
    await memberOf(app, (await signUpOwner(app)).business.id, 'ADMIN'); // elsewhere

    const { body } = await http().get(membersUrl(owner.business.id)).set('Cookie', owner.cookie).expect(200);

    expect(body).toEqual([
      { userId: ownerId, name: 'Lena', email: expect.stringMatching(/^owner-/), role: 'OWNER', staffId: null },
      { userId: master.userId, name: 'Lena', email: expect.any(String), role: 'MASTER', staffId: schedule.id },
    ]);
  });

  it('is for the owner and admins, not masters', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const master = await memberOf(app, owner.business.id, 'MASTER');

    await http().get(membersUrl(owner.business.id)).set('Cookie', admin.cookie).expect(200);
    await http().get(membersUrl(owner.business.id)).set('Cookie', master.cookie).expect(403);
  });
});

describe('changing a role', () => {
  it('lets the owner make a master an admin and back', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const url = memberUrl(owner.business.id, master.userId);

    const res = await http().patch(url).set('Cookie', owner.cookie).send({ role: 'ADMIN' }).expect(200);
    expect(res.body).toMatchObject({ userId: master.userId, role: 'ADMIN' });
    await http().patch(url).set('Cookie', owner.cookie).send({ role: 'MASTER' }).expect(200);
    expect(await roleIn(owner.business.id, master.userId)).toBe('MASTER');
  });

  // Admins manage masters only: making one an admin, or touching an admin, is the owner's.
  it('keeps an admin to masters', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const otherAdmin = await memberOf(app, owner.business.id, 'ADMIN');
    const master = await memberOf(app, owner.business.id, 'MASTER');

    await http()
      .patch(memberUrl(owner.business.id, master.userId))
      .set('Cookie', admin.cookie)
      .send({ role: 'ADMIN' })
      .expect(403);
    await http()
      .patch(memberUrl(owner.business.id, otherAdmin.userId))
      .set('Cookie', admin.cookie)
      .send({ role: 'MASTER' })
      .expect(403);
    expect(await roleIn(owner.business.id, master.userId)).toBe('MASTER');
    expect(await roleIn(owner.business.id, otherAdmin.userId)).toBe('ADMIN');
  });

  it('never makes or unmakes the owner', async () => {
    const owner = await signUpOwner(app);
    const ownerId = await userIdOf(app, owner.cookie);
    const master = await memberOf(app, owner.business.id, 'MASTER');

    await http()
      .patch(memberUrl(owner.business.id, master.userId))
      .set('Cookie', owner.cookie)
      .send({ role: 'OWNER' })
      .expect(400);
    await http()
      .patch(memberUrl(owner.business.id, ownerId))
      .set('Cookie', owner.cookie)
      .send({ role: 'ADMIN' })
      .expect(403);
    expect(await roleIn(owner.business.id, ownerId)).toBe('OWNER');
  });

  it('answers 404 to someone who is not a member of this business', async () => {
    const owner = await signUpOwner(app);
    const elsewhere = await memberOf(app, (await signUpOwner(app)).business.id, 'MASTER');

    await http()
      .patch(memberUrl(owner.business.id, elsewhere.userId))
      .set('Cookie', owner.cookie)
      .send({ role: 'ADMIN' })
      .expect(404);
    await http()
      .patch(memberUrl(owner.business.id, randomUUID()))
      .set('Cookie', owner.cookie)
      .send({ role: 'ADMIN' })
      .expect(404);
  });
});

describe('removing a member', () => {
  // The foreign key from staff would refuse the removal otherwise; the schedule stays, without
  // an account, for the bookings it holds.
  it('takes them out of the business and keeps their schedule, unlinked', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const schedule = await prisma.staff.create({
      data: { businessId: owner.business.id, name: 'M', userId: master.userId },
    });

    await http().delete(memberUrl(owner.business.id, master.userId)).set('Cookie', owner.cookie).expect(204);

    expect(await roleIn(owner.business.id, master.userId)).toBeNull();
    expect(await prisma.staff.findUnique({ where: { id: schedule.id } })).toMatchObject({ userId: null });
    await http().get(`/businesses/${owner.business.id}`).set('Cookie', master.cookie).expect(403);
  });

  it('lets an admin remove a master, but not another admin or the owner', async () => {
    const owner = await signUpOwner(app);
    const ownerId = await userIdOf(app, owner.cookie);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const otherAdmin = await memberOf(app, owner.business.id, 'ADMIN');
    const master = await memberOf(app, owner.business.id, 'MASTER');

    await http().delete(memberUrl(owner.business.id, otherAdmin.userId)).set('Cookie', admin.cookie).expect(403);
    await http().delete(memberUrl(owner.business.id, ownerId)).set('Cookie', admin.cookie).expect(403);
    await http().delete(memberUrl(owner.business.id, master.userId)).set('Cookie', admin.cookie).expect(204);
    expect(await roleIn(owner.business.id, otherAdmin.userId)).toBe('ADMIN');
    expect(await roleIn(owner.business.id, master.userId)).toBeNull();
  });

  it('does not let a master remove anyone', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const other = await memberOf(app, owner.business.id, 'MASTER');

    await http().delete(memberUrl(owner.business.id, other.userId)).set('Cookie', master.cookie).expect(403);
    expect(await roleIn(owner.business.id, other.userId)).toBe('MASTER');
  });

  it("answers 404 to another business's member, and leaves them there", async () => {
    const owner = await signUpOwner(app);
    const other = await signUpOwner(app);
    const theirs = await memberOf(app, other.business.id, 'MASTER');

    await http().delete(memberUrl(owner.business.id, theirs.userId)).set('Cookie', owner.cookie).expect(404);
    expect(await roleIn(other.business.id, theirs.userId)).toBe('MASTER');
  });
});

// An invitation is as good as its inviter's right to give it: leaving the team, or a role that
// may no longer invite as that, revokes it. Otherwise a removed admin keeps a way back in.
describe('invitations of a member who leaves or changes role', () => {
  const inviteAs = async (inviter: { cookie: string }, businessId: string, role: 'ADMIN' | 'MASTER') => {
    const { body } = await http()
      .post(`/businesses/${businessId}/invitations`)
      .set('Cookie', inviter.cookie)
      .send({ role })
      .expect(201);
    return {
      id: (body as { invitation: { id: string } }).invitation.id,
      token: new URL(body.link).pathname.split('/').pop()!,
    };
  };
  const pendingIds = async (owner: { cookie: string }, businessId: string) =>
    (
      (await http().get(`/businesses/${businessId}/invitations`).set('Cookie', owner.cookie).expect(200)).body as {
        id: string;
      }[]
    ).map(({ id }) => id);

  it('keeps a removed admin from coming back through their own link', async () => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const admin = await memberOf(app, businessId, 'ADMIN');
    const theirs = await inviteAs(admin, businessId, 'MASTER');
    const ownersOwn = await inviteAs(owner, businessId, 'MASTER');

    await http().delete(memberUrl(businessId, admin.userId)).set('Cookie', owner.cookie).expect(204);

    await http().post(`/invitations/${theirs.token}/accept`).set('Cookie', admin.cookie).expect(404);
    expect(await roleIn(businessId, admin.userId)).toBeNull();
    expect(await pendingIds(owner, businessId)).toEqual([ownersOwn.id]);
  });

  it('revokes what the new role may no longer give, and keeps the rest', async () => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const admin = await memberOf(app, businessId, 'ADMIN');
    const otherAdmin = await memberOf(app, businessId, 'ADMIN');
    await inviteAs(admin, businessId, 'MASTER');
    const kept = await inviteAs(otherAdmin, businessId, 'MASTER');

    await http()
      .patch(memberUrl(businessId, admin.userId))
      .set('Cookie', owner.cookie)
      .send({ role: 'MASTER' })
      .expect(200);

    expect(await pendingIds(owner, businessId)).toEqual([kept.id]);
  });
});

// The role is checked, then written; a change in between must not slip through on the old check.
describe('a member changed between the check and the write', () => {
  // Runs `meanwhile` once, right after the first authorization check of the next request passes.
  const changeAfterCheck = (meanwhile: () => Promise<unknown>) => {
    const authorization = app.get(AuthorizationService);
    const original = authorization.authorize.bind(authorization);
    const spy = vi.spyOn(authorization, 'authorize').mockImplementationOnce(async (...args) => {
      await original(...args);
      await meanwhile();
    });
    return spy;
  };

  it('answers 409 to a role change, and keeps the change made meanwhile', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const spy = changeAfterCheck(() =>
      prisma.membership.update({
        where: { userId_businessId: { userId: master.userId, businessId: owner.business.id } },
        data: { role: 'ADMIN' },
      }),
    );

    try {
      await http()
        .patch(memberUrl(owner.business.id, master.userId))
        .set('Cookie', owner.cookie)
        .send({ role: 'MASTER' })
        .expect(409);
    } finally {
      spy.mockRestore();
    }
    expect(await roleIn(owner.business.id, master.userId)).toBe('ADMIN');
  });

  it('answers 409 to a removal, and keeps the member', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const spy = changeAfterCheck(() =>
      prisma.membership.update({
        where: { userId_businessId: { userId: master.userId, businessId: owner.business.id } },
        data: { role: 'ADMIN' },
      }),
    );

    try {
      await http().delete(memberUrl(owner.business.id, master.userId)).set('Cookie', owner.cookie).expect(409);
    } finally {
      spy.mockRestore();
    }
    expect(await roleIn(owner.business.id, master.userId)).toBe('ADMIN');
  });
});
