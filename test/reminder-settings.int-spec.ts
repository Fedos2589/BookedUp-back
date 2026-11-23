import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { memberOf, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const http = () => request(app.getHttpServer());
const businessUrl = (businessId: string) => `/businesses/${businessId}`;
const put = (businessId: string, cookie: string, body: object) =>
  http()
    .put(`${businessUrl(businessId)}/reminders`)
    .set('Cookie', cookie)
    .send(body);
const offsetsOf = async (businessId: string, cookie: string) =>
  ((await http().get(businessUrl(businessId)).set('Cookie', cookie).expect(200)).body as { reminderOffsets: number[] })
    .reminderOffsets;

describe('reminder times', () => {
  it('start as one day before', async () => {
    const owner = await signUpOwner(app);

    expect(await offsetsOf(owner.business.id, owner.cookie)).toEqual([1440]);
  });

  it('are set by the owner, answered sorted by the business and by GET', async () => {
    const owner = await signUpOwner(app);

    const res = await put(owner.business.id, owner.cookie, { offsets: [1440, 60] }).expect(200);

    expect(res.body).toMatchObject({ id: owner.business.id, role: 'OWNER', reminderOffsets: [60, 1440] });
    expect(await offsetsOf(owner.business.id, owner.cookie)).toEqual([60, 1440]);
  });

  it('can be switched off with none', async () => {
    const owner = await signUpOwner(app);

    await put(owner.business.id, owner.cookie, { offsets: [] }).expect(200);

    expect(await offsetsOf(owner.business.id, owner.cookie)).toEqual([]);
  });

  it('are set by an admin, not by a master', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const master = await memberOf(app, owner.business.id, 'MASTER');

    await put(owner.business.id, master.cookie, { offsets: [60] }).expect(403);
    expect(await offsetsOf(owner.business.id, owner.cookie)).toEqual([1440]);
    await put(owner.business.id, admin.cookie, { offsets: [120] }).expect(200);
    expect(await offsetsOf(owner.business.id, owner.cookie)).toEqual([120]);
  });

  it("refuse another business's owner", async () => {
    const owner = await signUpOwner(app);
    const stranger = await signUpOwner(app);

    await put(owner.business.id, stranger.cookie, { offsets: [60] }).expect(403);

    expect(await offsetsOf(owner.business.id, owner.cookie)).toEqual([1440]);
  });

  it.each([
    ['a time not on the list', { offsets: [30] }],
    ['a repeat', { offsets: [1440, 1440] }],
    ['four times', { offsets: [60, 120, 180, 1440] }],
    ['no list', {}],
    ['not numbers', { offsets: ['60'] }],
  ])('answer 400 to %s', async (_name, body) => {
    const owner = await signUpOwner(app);

    await put(owner.business.id, owner.cookie, body).expect(400);

    expect(await offsetsOf(owner.business.id, owner.cookie)).toEqual([1440]);
  });
});
