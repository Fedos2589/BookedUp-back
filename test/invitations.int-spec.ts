import { PasswordHasher } from '@nestjs/authentication';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { memberOf, ownerInput, sessionCookie, signUpOwner, userIdOf } from './helpers.js';
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

// What the person who got the link does with it.
describe('the invitation link', () => {
  const linkUrl = (token: string) => `/invitations/${token}`;

  const inviteAs = async (role: 'ADMIN' | 'MASTER', body: object = {}) => {
    const owner = await signUpOwner(app);
    const { body: created } = await invite({ ...owner, businessId: owner.business.id }, { role, ...body }).expect(201);
    return { owner, token: tokenOf(created.link), invitation: created.invitation as { id: string } };
  };

  const newcomer = () => {
    const { email, password } = ownerInput();
    return { email, password, name: 'Anna' };
  };

  it('tells anyone holding it which business, role and inviter it is for', async () => {
    const { owner, token } = await inviteAs('ADMIN');

    await http()
      .get(linkUrl(token))
      .expect(200)
      .expect({ businessName: owner.business.name, role: 'ADMIN', invitedBy: 'Lena' });
  });

  it('makes a signed-in account a member with the role', async () => {
    const { owner, token } = await inviteAs('MASTER');
    const someone = await signUpOwner(app);

    await http()
      .post(`${linkUrl(token)}/accept`)
      .set('Cookie', someone.cookie)
      .expect(200)
      .expect({ ...owner.business, role: 'MASTER' });
    await http().get(`/businesses/${owner.business.id}`).set('Cookie', someone.cookie).expect(200);
  });

  it('works once', async () => {
    const { token } = await inviteAs('MASTER');
    const first = await signUpOwner(app);
    const second = await signUpOwner(app);

    await http()
      .post(`${linkUrl(token)}/accept`)
      .set('Cookie', first.cookie)
      .expect(200);
    await http()
      .post(`${linkUrl(token)}/accept`)
      .set('Cookie', second.cookie)
      .expect(404);
    await http().get(linkUrl(token)).expect(404);
  });

  // Two people opening the same link at once: one joins, the other is told it is used.
  it('lets one of two simultaneous accepts through', async () => {
    const { owner, token } = await inviteAs('MASTER');
    const people = await Promise.all([signUpOwner(app), signUpOwner(app), signUpOwner(app)]);

    const answers = await Promise.all(
      people.map(({ cookie }) =>
        http()
          .post(`${linkUrl(token)}/accept`)
          .set('Cookie', cookie),
      ),
    );

    expect(answers.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 404, 404]);
    expect(await prisma.membership.count({ where: { businessId: owner.business.id } })).toBe(2);
  });

  it('stops working when revoked or expired, and for a made-up token', async () => {
    const revoked = await inviteAs('MASTER');
    await http()
      .delete(`${invitationsUrl(revoked.owner.business.id)}/${revoked.invitation.id}`)
      .set('Cookie', revoked.owner.cookie)
      .expect(204);
    const expired = await inviteAs('MASTER');
    await prisma.invitation.update({
      where: { id: expired.invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const someone = await signUpOwner(app);

    for (const token of [revoked.token, expired.token, 'made-up']) {
      await http().get(linkUrl(token)).expect(404);
      await http()
        .post(`${linkUrl(token)}/accept`)
        .set('Cookie', someone.cookie)
        .expect(404);
    }
  });

  // The link is not spent on someone who is in already: it can still go to the right person.
  it('refuses a member of the business, and keeps the link good', async () => {
    const { owner, token } = await inviteAs('MASTER');

    await http()
      .post(`${linkUrl(token)}/accept`)
      .set('Cookie', owner.cookie)
      .expect(409);
    await http().get(linkUrl(token)).expect(200);
  });

  it('needs a session to accept', async () => {
    const { token } = await inviteAs('MASTER');

    await http()
      .post(`${linkUrl(token)}/accept`)
      .expect(401);
    await http().get(linkUrl(token)).expect(200);
  });

  it('links the offered schedule to whoever accepts', async () => {
    const owner = await signUpOwner(app);
    const schedule = await prisma.staff.create({ data: { businessId: owner.business.id, name: 'Anna' } });
    const { body } = await invite(
      { ...owner, businessId: owner.business.id },
      { role: 'MASTER', staffId: schedule.id },
    );
    const someone = await signUpOwner(app);

    await http()
      .post(`${linkUrl(tokenOf(body.link))}/accept`)
      .set('Cookie', someone.cookie)
      .expect(200);

    expect(await prisma.staff.findUnique({ where: { id: schedule.id } })).toMatchObject({
      userId: await userIdOf(app, someone.cookie),
    });
  });

  // The same schedule offered twice (two messengers, two people sending): once one link is
  // used, the others can only fail, so they are revoked with it and leave the pending list.
  it('revokes the other links to a schedule once one is accepted', async () => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const schedule = await prisma.staff.create({ data: { businessId, name: 'Anna' } });
    const first = await invite({ ...owner, businessId }, { role: 'MASTER', staffId: schedule.id });
    const second = await invite({ ...owner, businessId }, { role: 'MASTER', staffId: schedule.id });
    const unrelated = await invite({ ...owner, businessId }, { role: 'MASTER' });
    const [a, b] = await Promise.all([signUpOwner(app), signUpOwner(app)]);

    await http()
      .post(`${linkUrl(tokenOf(first.body.link))}/accept`)
      .set('Cookie', a.cookie)
      .expect(200);

    expect((await pending(owner)).map(({ id }) => id)).toEqual([unrelated.body.invitation.id]);
    await http()
      .post(`${linkUrl(tokenOf(second.body.link))}/accept`)
      .set('Cookie', b.cookie)
      .expect(404);
    await http().get(`/businesses/${businessId}`).set('Cookie', b.cookie).expect(403);
  });

  // Archived after the link was given: the accept joins nobody and leaves the link as it was.
  it('refuses a schedule archived since, and changes nothing', async () => {
    const owner = await signUpOwner(app);
    const businessId = owner.business.id;
    const schedule = await prisma.staff.create({ data: { businessId, name: 'Anna' } });
    const { body } = await invite({ ...owner, businessId }, { role: 'MASTER', staffId: schedule.id });
    await http()
      .patch(`/businesses/${businessId}/staff/${schedule.id}`)
      .set('Cookie', owner.cookie)
      .send({ archived: true });
    const someone = await signUpOwner(app);

    await http()
      .post(`${linkUrl(tokenOf(body.link))}/accept`)
      .set('Cookie', someone.cookie)
      .expect(409);

    await http().get(`/businesses/${businessId}`).set('Cookie', someone.cookie).expect(403);
    await http()
      .get(linkUrl(tokenOf(body.link)))
      .expect(200);
  });

  it('refuses to revoke an invitation once accepted', async () => {
    const { owner, token, invitation } = await inviteAs('MASTER');
    const someone = await signUpOwner(app);
    await http()
      .post(`${linkUrl(token)}/accept`)
      .set('Cookie', someone.cookie)
      .expect(200);

    await http()
      .delete(`${invitationsUrl(owner.business.id)}/${invitation.id}`)
      .set('Cookie', owner.cookie)
      .expect(409);
  });

  describe('signing up through it', () => {
    it('creates the account, makes it a member and signs it in', async () => {
      const { owner, token } = await inviteAs('ADMIN');
      const input = newcomer();

      const res = await http()
        .post(`${linkUrl(token)}/sign-up`)
        .send(input)
        .expect(201);

      expect(res.body).toEqual({
        user: { id: expect.any(String), email: input.email, name: 'Anna' },
        business: { ...owner.business, role: 'ADMIN' },
      });
      const cookie = sessionCookie(res);
      expect(cookie).toBeDefined();
      await http().get(`/businesses/${owner.business.id}`).set('Cookie', cookie!).expect(200);
    });

    // One transaction: no account is left behind by a link that doesn't work.
    it('creates no account for a link that does not work', async () => {
      const input = newcomer();

      await http()
        .post(`${linkUrl('made-up')}/sign-up`)
        .send(input)
        .expect(404);

      expect(await prisma.user.count({ where: { email: input.email } })).toBe(0);
    });

    // A slow hash per made-up token would let anyone spend the server's CPU for free.
    it('does not hash the password for a link that does not work', async () => {
      const hash = vi.spyOn(app.get(PasswordHasher), 'hash');

      try {
        await http()
          .post(`${linkUrl('made-up')}/sign-up`)
          .send(newcomer())
          .expect(404);
        expect(hash).not.toHaveBeenCalled();
      } finally {
        hash.mockRestore();
      }
    });

    it('says the email is registered, and keeps the link good', async () => {
      const { token } = await inviteAs('MASTER');
      const taken = ownerInput();
      await http().post('/auth/sign-up').send(taken).expect(201);

      const res = await http()
        .post(`${linkUrl(token)}/sign-up`)
        .send({ ...newcomer(), email: taken.email.toUpperCase() })
        .expect(409);

      expect(res.body).toMatchObject({ field: 'email' });
      await http().get(linkUrl(token)).expect(200);
    });

    it('holds the password to the sign-up rules', async () => {
      const { token } = await inviteAs('MASTER');

      await http()
        .post(`${linkUrl(token)}/sign-up`)
        .send({ ...newcomer(), password: 'short' })
        .expect(400);
    });
  });
});
