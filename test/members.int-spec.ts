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
