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
const mine = '/me/notifications';
const inBusiness = (businessId: string) => `/businesses/${businessId}/me/notifications`;

describe('my email switch', () => {
  it('is on until switched, and changes only the caller’s account', async () => {
    const me = await signUpOwner(app);
    const other = await signUpOwner(app);
    await http().get(mine).set('Cookie', me.cookie).expect(200).expect({ email: true });

    await http().put(mine).set('Cookie', me.cookie).send({ email: false }).expect(200).expect({ email: false });

    await http().get(mine).set('Cookie', me.cookie).expect(200).expect({ email: false });
    await http().get(mine).set('Cookie', other.cookie).expect(200).expect({ email: true });
  });

  it('wants a boolean and a session', async () => {
    const me = await signUpOwner(app);

    await http().put(mine).set('Cookie', me.cookie).send({ email: 'no' }).expect(400);
    await http().get(mine).expect(401);
  });
});

describe('my «all online bookings» switch in a business', () => {
  it('is on for the owner and an admin, and not offered (null) to a master', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const url = inBusiness(owner.business.id);

    await http().get(url).set('Cookie', owner.cookie).expect(200).expect({ allOnline: true });
    await http().get(url).set('Cookie', admin.cookie).expect(200).expect({ allOnline: true });
    await http().get(url).set('Cookie', master.cookie).expect(200).expect({ allOnline: null });
  });

  it('changes only the caller’s own membership', async () => {
    const owner = await signUpOwner(app);
    const admin = await memberOf(app, owner.business.id, 'ADMIN');
    const url = inBusiness(owner.business.id);

    await http()
      .put(url)
      .set('Cookie', admin.cookie)
      .send({ allOnline: false })
      .expect(200)
      .expect({ allOnline: false });

    await http().get(url).set('Cookie', admin.cookie).expect(200).expect({ allOnline: false });
    await http().get(url).set('Cookie', owner.cookie).expect(200).expect({ allOnline: true });
  });

  it('answers 400 to a master, and keeps their row', async () => {
    const owner = await signUpOwner(app);
    const master = await memberOf(app, owner.business.id, 'MASTER');
    const url = inBusiness(owner.business.id);

    await http().put(url).set('Cookie', master.cookie).send({ allOnline: false }).expect(400);

    await http().get(url).set('Cookie', master.cookie).expect(200).expect({ allOnline: null });
  });

  it('answers 400 to something that is not a boolean', async () => {
    const owner = await signUpOwner(app);

    await http().put(inBusiness(owner.business.id)).set('Cookie', owner.cookie).send({ allOnline: 'no' }).expect(400);
  });

  it('is closed to someone who is not a member of the business', async () => {
    const owner = await signUpOwner(app);
    const stranger = await signUpOwner(app);
    const url = inBusiness(owner.business.id);

    await http().get(url).set('Cookie', stranger.cookie).expect(403);
    await http().put(url).set('Cookie', stranger.cookie).send({ allOnline: false }).expect(403);

    await http().get(url).set('Cookie', owner.cookie).expect(200).expect({ allOnline: true });
  });
});
