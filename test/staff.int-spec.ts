import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import type { MemberRole } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { memberOf as memberOfBusiness, signUpOwner, userIdOf as userIdOfAccount } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;
let prisma: PrismaService;

const http = () => request(app.getHttpServer());
const staffUrl = (businessId: string) => `/businesses/${businessId}/staff`;

const userIdOf = (cookie: string) => userIdOfAccount(app, cookie);
const memberOf = (businessId: string, role: MemberRole) => memberOfBusiness(app, businessId, role);

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

describe('the team of a business', () => {
  it('starts empty and lists the staff in the order they were added', async () => {
    const owner = await signUpOwner(app);
    await http().get(staffUrl(owner.business.id)).set('Cookie', owner.cookie).expect(200).expect([]);

    const anna = await http().post(staffUrl(owner.business.id)).set('Cookie', owner.cookie).send({ name: 'Anna' });
    const boris = await http().post(staffUrl(owner.business.id)).set('Cookie', owner.cookie).send({ name: 'Boris' });

    expect(anna.status).toBe(201);
    expect(anna.body).toEqual({
      id: expect.any(String),
      name: 'Anna',
      userId: null,
      archived: false,
      scheduleMode: 'HOURS',
    });
    await http()
      .get(staffUrl(owner.business.id))
      .set('Cookie', owner.cookie)
      .expect(200)
      .expect([anna.body, boris.body]);
  });

  it("lists only this business's staff", async () => {
    const owner = await signUpOwner(app);
    const other = await signUpOwner(app);
    await http().post(staffUrl(other.business.id)).set('Cookie', other.cookie).send({ name: 'Elsewhere' }).expect(201);

    await http().get(staffUrl(owner.business.id)).set('Cookie', owner.cookie).expect(200).expect([]);
  });

  it('trims the name and refuses an empty one', async () => {
    const owner = await signUpOwner(app);

    const res = await http().post(staffUrl(owner.business.id)).set('Cookie', owner.cookie).send({ name: '  Anna ' });
    expect(res.body).toMatchObject({ name: 'Anna' });
    await http().post(staffUrl(owner.business.id)).set('Cookie', owner.cookie).send({ name: '   ' }).expect(400);
  });

  // An owner of a small studio takes clients too.
  it("links a schedule to a member's account, once", async () => {
    const owner = await signUpOwner(app);
    const ownerId = await userIdOf(owner.cookie);

    const res = await http()
      .post(staffUrl(owner.business.id))
      .set('Cookie', owner.cookie)
      .send({ name: 'Lena', userId: ownerId })
      .expect(201);
    expect(res.body).toMatchObject({ userId: ownerId });

    const again = await http()
      .post(staffUrl(owner.business.id))
      .set('Cookie', owner.cookie)
      .send({ name: 'Lena again', userId: ownerId })
      .expect(409);
    expect(again.body).toMatchObject({ field: 'userId' });
  });

  it('refuses to link a schedule to someone who is not a member', async () => {
    const owner = await signUpOwner(app);
    const stranger = await signUpOwner(app);

    const res = await http()
      .post(staffUrl(owner.business.id))
      .set('Cookie', owner.cookie)
      .send({ name: 'Stranger', userId: await userIdOf(stranger.cookie) })
      .expect(400);
    expect(res.body.message).toEqual(['userId: Not a member of this business']);
  });

  it('renames and archives, and brings back from the archive', async () => {
    const owner = await signUpOwner(app);
    const { body: anna } = await http()
      .post(staffUrl(owner.business.id))
      .set('Cookie', owner.cookie)
      .send({ name: 'Anna' });
    const url = `${staffUrl(owner.business.id)}/${anna.id}`;

    await http()
      .patch(url)
      .set('Cookie', owner.cookie)
      .send({ name: 'Anna K.', archived: true })
      .expect(200)
      .expect({ ...anna, name: 'Anna K.', archived: true });
    await http()
      .patch(url)
      .set('Cookie', owner.cookie)
      .send({ archived: false })
      .expect(200)
      .expect({ ...anna, name: 'Anna K.', archived: false });
  });

  // The date someone left is what bookings (E6) will lean on. A form that sends every field
  // again, archived: true included, to fix a name must not move it.
  it('keeps the date someone was archived when archived: true comes again', async () => {
    const owner = await signUpOwner(app);
    const { body: anna } = await http()
      .post(staffUrl(owner.business.id))
      .set('Cookie', owner.cookie)
      .send({ name: 'Anna' });
    const url = `${staffUrl(owner.business.id)}/${anna.id}`;
    const archivedAt = async () => (await prisma.staff.findUniqueOrThrow({ where: { id: anna.id } })).archivedAt;

    await http().patch(url).set('Cookie', owner.cookie).send({ archived: true }).expect(200);
    const left = await archivedAt();
    await http()
      .patch(url)
      .set('Cookie', owner.cookie)
      .send({ name: 'Anna K.', archived: true })
      .expect(200)
      .expect({ ...anna, name: 'Anna K.', archived: true });

    expect(left).not.toBeNull();
    expect(await archivedAt()).toEqual(left);
  });

  // The guard lets the owner of business A in; the staff id belongs to business B.
  it("answers 404 to another business's staff, and leaves it unchanged", async () => {
    const owner = await signUpOwner(app);
    const other = await signUpOwner(app);
    const { body: theirs } = await http()
      .post(staffUrl(other.business.id))
      .set('Cookie', other.cookie)
      .send({ name: 'Theirs' });

    await http()
      .patch(`${staffUrl(owner.business.id)}/${theirs.id}`)
      .set('Cookie', owner.cookie)
      .send({ name: 'Mine now' })
      .expect(404);
    await http()
      .patch(`${staffUrl(owner.business.id)}/${randomUUID()}`)
      .set('Cookie', owner.cookie)
      .send({})
      .expect(404);
    expect(await prisma.staff.findUnique({ where: { id: theirs.id } })).toMatchObject({ name: 'Theirs' });
  });
});

describe('who may change the team', () => {
  it('lets an admin add and change staff', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(owner.business.id, 'ADMIN');

    const { body } = await http()
      .post(staffUrl(owner.business.id))
      .set('Cookie', admin.cookie)
      .send({ name: 'Anna' })
      .expect(201);
    await http()
      .patch(`${staffUrl(owner.business.id)}/${body.id}`)
      .set('Cookie', admin.cookie)
      .send({ archived: true })
      .expect(200);
  });

  it('lets a master see the team but not change it', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(owner.business.id, 'MASTER');
    const { body: anna } = await http()
      .post(staffUrl(owner.business.id))
      .set('Cookie', owner.cookie)
      .send({ name: 'Anna' });

    await http().get(staffUrl(owner.business.id)).set('Cookie', master.cookie).expect(200).expect([anna]);
    await http().post(staffUrl(owner.business.id)).set('Cookie', master.cookie).send({ name: 'Boris' }).expect(403);
    await http()
      .patch(`${staffUrl(owner.business.id)}/${anna.id}`)
      .set('Cookie', master.cookie)
      .send({ name: 'Renamed' })
      .expect(403);
    expect(await prisma.staff.count({ where: { businessId: owner.business.id } })).toBe(1);
  });
});

describe('staff in the database', () => {
  // The foreign key goes to memberships: a schedule can't point at an account outside the business.
  it("refuses a user who isn't a member, even through raw writes", async () => {
    const owner = await signUpOwner(app);
    const stranger = await signUpOwner(app);

    await expect(
      prisma.staff.create({
        data: { businessId: owner.business.id, name: 'X', userId: await userIdOf(stranger.cookie) },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  // NO ACTION, not RESTRICT: checked after the cascade from the business has removed the staff too.
  it('lets a business be erased while a schedule is linked to a member', async () => {
    const owner = await signUpOwner(app);
    await prisma.staff.create({
      data: { businessId: owner.business.id, name: 'Lena', userId: await userIdOf(owner.cookie) },
    });

    await prisma.business.delete({ where: { id: owner.business.id } });
    expect(await prisma.staff.count({ where: { businessId: owner.business.id } })).toBe(0);
  });

  it('keeps a member who has a schedule from being removed without unlinking it', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(owner.business.id, 'MASTER');
    await prisma.staff.create({ data: { businessId: owner.business.id, name: 'M', userId: master.userId } });

    await expect(
      prisma.membership.delete({
        where: { userId_businessId: { userId: master.userId, businessId: owner.business.id } },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});

// Whose schedule one may touch follows roles.ts: a member's schedule counts as that member, one
// without an account as a master. One's own schedule is always one's own to keep.
describe('who may change whose schedule', () => {
  const scheduleOf = (businessId: string, userId: string, name = 'S') =>
    prisma.staff.create({ data: { businessId, name, userId } });

  it("keeps an admin off the owner's and other admins' schedules", async () => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const admin = await memberOf(businessId, 'ADMIN');
    const otherAdmin = await memberOf(businessId, 'ADMIN');
    const owners = await scheduleOf(businessId, await userIdOf(owner.cookie), 'Lena');
    const otherAdmins = await scheduleOf(businessId, otherAdmin.userId, 'Olga');

    for (const schedule of [owners, otherAdmins]) {
      await http()
        .patch(`${staffUrl(businessId)}/${schedule.id}`)
        .set('Cookie', admin.cookie)
        .send({ archived: true })
        .expect(403);
    }
    expect(await prisma.staff.count({ where: { businessId, archivedAt: { not: null } } })).toBe(0);
  });

  it('keeps an admin from giving the owner a schedule', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(owner.business.id, 'ADMIN');

    await http()
      .post(staffUrl(owner.business.id))
      .set('Cookie', admin.cookie)
      .send({ name: 'Lena', userId: await userIdOf(owner.cookie) })
      .expect(403);
  });

  it("lets an admin keep their own schedule and change masters'", async () => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const admin = await memberOf(businessId, 'ADMIN');
    const master = await memberOf(businessId, 'MASTER');
    const masters = await scheduleOf(businessId, master.userId);

    const { body: own } = await http()
      .post(staffUrl(businessId))
      .set('Cookie', admin.cookie)
      .send({ name: 'Me', userId: admin.userId })
      .expect(201);
    await http()
      .patch(`${staffUrl(businessId)}/${own.id}`)
      .set('Cookie', admin.cookie)
      .send({ name: 'Me again' })
      .expect(200);
    await http()
      .patch(`${staffUrl(businessId)}/${masters.id}`)
      .set('Cookie', admin.cookie)
      .send({ name: 'M' })
      .expect(200);
  });

  it("lets the owner change an admin's schedule", async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(owner.business.id, 'ADMIN');
    const admins = await scheduleOf(owner.business.id, admin.userId);

    await http()
      .patch(`${staffUrl(owner.business.id)}/${admins.id}`)
      .set('Cookie', owner.cookie)
      .send({ archived: true })
      .expect(200);
  });
});
