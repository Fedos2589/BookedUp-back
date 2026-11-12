import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import type { MemberRole } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { memberOf as memberOfBusiness, signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

let app: INestApplication<App>;

const http = () => request(app.getHttpServer());
const memberOf = (businessId: string, role: MemberRole) => memberOfBusiness(app, businessId, role);

const staffUrl = (businessId: string, staffId: string) => `/businesses/${businessId}/staff/${staffId}`;
const weeklyUrl = (businessId: string, staffId: string) => `${staffUrl(businessId, staffId)}/weekly-windows`;
const timeOffUrl = (businessId: string, staffId: string) => `${staffUrl(businessId, staffId)}/time-off`;
// What a slot of hours mode carries besides its time.
const oneSeat = { description: null, capacity: 1, booked: 0, groupId: null, oneOffSessionId: null };
const modeUrl = (businessId: string, staffId: string) => `${staffUrl(businessId, staffId)}/schedule-mode`;
const overridesUrl = (businessId: string, staffId: string) => `${staffUrl(businessId, staffId)}/day-overrides`;
const slotsUrl = (businessId: string) => `/businesses/${businessId}/slots`;

// A Monday far enough ahead that its slots are never in the past. The business is in Moscow (UTC+3).
const monday = '2030-01-07';

const window = (overrides: Record<string, unknown> = {}) => ({
  weekday: 1,
  startMinute: 600,
  durationMinutes: 180,
  slotMinutes: 60,
  title: null,
  ...overrides,
});

const addStaff = async (owner: { cookie: string; business: { id: string } }, name = 'Anna') =>
  (await http().post(`/businesses/${owner.business.id}/staff`).set('Cookie', owner.cookie).send({ name }).expect(201))
    .body.id as string;

// A member of the business with a schedule of their own.
const memberWithSchedule = async (businessId: string, role: MemberRole) => {
  const member = await memberOf(businessId, role);
  const staff = await app
    .get(PrismaService)
    .staff.create({ data: { businessId, name: role, userId: member.userId }, select: { id: true } });
  return { ...member, staffId: staff.id };
};

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('the weekly windows of a master', () => {
  it('start empty, are saved as a whole week and come back in the order of the week', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const url = weeklyUrl(owner.business.id, anna);
    await http().get(url).set('Cookie', owner.cookie).expect(200).expect({ windows: [] });

    const week = [window({ weekday: 3 }), window({ startMinute: 1020, durationMinutes: 60, title: 'Football' })];
    await http()
      .put(url)
      .set('Cookie', owner.cookie)
      .send({ windows: week })
      .expect(200)
      .expect({ windows: [week[1], week[0]] });

    await http()
      .put(url)
      .set('Cookie', owner.cookie)
      .send({ windows: [window()] })
      .expect(200);
    await http()
      .get(url)
      .set('Cookie', owner.cookie)
      .expect(200)
      .expect({ windows: [window()] });
  });

  it('refuses a week where two windows overlap, or a slot longer than its window, and keeps the old week', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const url = weeklyUrl(owner.business.id, anna);
    await http()
      .put(url)
      .set('Cookie', owner.cookie)
      .send({ windows: [window()] })
      .expect(200);

    const overlap = await http()
      .put(url)
      .set('Cookie', owner.cookie)
      .send({ windows: [window(), window({ startMinute: 700 })] })
      .expect(400);
    expect(overlap.body.message).toEqual(['windows.1: Overlaps windows.0']);
    const long = await http()
      .put(url)
      .set('Cookie', owner.cookie)
      .send({ windows: [window({ slotMinutes: 240 })] })
      .expect(400);
    expect(long.body.message).toEqual(['windows.0.slotMinutes: Longer than the window']);

    await http()
      .get(url)
      .set('Cookie', owner.cookie)
      .expect(200)
      .expect({ windows: [window()] });
  });

  it('turns an empty title into none', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);

    const res = await http()
      .put(weeklyUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .send({ windows: [window({ title: '  ' })] })
      .expect(200);
    expect(res.body.windows[0].title).toBeNull();
  });

  it("answers 404 for another business's master", async () => {
    const owner = await signUpOwner(app);
    const other = await signUpOwner(app);
    const elsewhere = await addStaff(other);

    await http().get(weeklyUrl(owner.business.id, elsewhere)).set('Cookie', owner.cookie).expect(404);
    await http()
      .put(weeklyUrl(owner.business.id, elsewhere))
      .set('Cookie', owner.cookie)
      .send({ windows: [] })
      .expect(404);
    await http().get(timeOffUrl(owner.business.id, elsewhere)).set('Cookie', owner.cookie).expect(404);
  });

  it('keeps one whole week when saves of different weeks race', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const url = weeklyUrl(owner.business.id, anna);
    const weeks = Array.from({ length: 8 }, (_, i) => [window({ weekday: 1 + (i % 7), startMinute: 60 * i })]);

    await Promise.all(
      weeks.map((windows) => http().put(url).set('Cookie', owner.cookie).send({ windows }).expect(200)),
    );

    const { body } = await http().get(url).set('Cookie', owner.cookie).expect(200);
    expect(weeks).toContainEqual(body.windows);
  });

  it('may be changed by a master for their own schedule only, and by an admin for a master', async () => {
    const owner = await signUpOwner(app);
    const master = await memberWithSchedule(owner.business.id, 'MASTER');
    const admin = await memberWithSchedule(owner.business.id, 'ADMIN');
    const anna = await addStaff(owner);
    const week = { windows: [window()] };

    await http().put(weeklyUrl(owner.business.id, master.staffId)).set('Cookie', master.cookie).send(week).expect(200);
    await http().put(weeklyUrl(owner.business.id, anna)).set('Cookie', master.cookie).send(week).expect(403);
    await http().put(weeklyUrl(owner.business.id, admin.staffId)).set('Cookie', master.cookie).send(week).expect(403);
    await http().put(weeklyUrl(owner.business.id, master.staffId)).set('Cookie', admin.cookie).send(week).expect(200);
    await http().put(weeklyUrl(owner.business.id, anna)).set('Cookie', admin.cookie).send(week).expect(200);
    // Every member sees everyone's week.
    await http().get(weeklyUrl(owner.business.id, admin.staffId)).set('Cookie', master.cookie).expect(200);
  });
});

describe('the day overrides of a master', () => {
  const tuesday = '2030-01-08';
  const noon = { startMinute: 12 * 60, durationMinutes: 120, slotMinutes: 60 };

  it('are put, listed by date and removed', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const url = overridesUrl(owner.business.id, anna);
    const as = (req: request.Test) => req.set('Cookie', owner.cookie);

    await as(
      http()
        .put(`${url}/2030-01-10`)
        .send({ windows: [noon] }),
    )
      .expect(200)
      .expect({ date: '2030-01-10', windows: [noon] });
    await as(
      http()
        .put(`${url}/${tuesday}`)
        .send({ windows: [noon] }),
    ).expect(200);
    await as(
      http()
        .put(`${url}/${tuesday}`)
        .send({ windows: [{ ...noon, startMinute: 9 * 60 }] }),
    ).expect(200);
    await as(http().get(url))
      .expect(200)
      .expect([
        { date: tuesday, windows: [{ ...noon, startMinute: 9 * 60 }] },
        { date: '2030-01-10', windows: [noon] },
      ]);

    await as(http().delete(`${url}/${tuesday}`)).expect(204);
    await as(http().delete(`${url}/${tuesday}`)).expect(404);
    await as(http().get(url))
      .expect(200)
      .expect([{ date: '2030-01-10', windows: [noon] }]);
  });

  it('with no windows are a day off, and the slots of that day go', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    await http()
      .put(weeklyUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .send({ windows: [window({ weekday: 2 })] });

    await http()
      .put(`${overridesUrl(owner.business.id, anna)}/${tuesday}`)
      .set('Cookie', owner.cookie)
      .send({ windows: [] })
      .expect(200);

    await http()
      .get(slotsUrl(owner.business.id))
      .query({ from: tuesday, to: tuesday })
      .set('Cookie', owner.cookie)
      .expect(200)
      .expect([]);
  });

  it('refuse overlapping windows, or a slot longer than its window, with 400 and keep the old one', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const url = `${overridesUrl(owner.business.id, anna)}/${tuesday}`;
    await http()
      .put(url)
      .set('Cookie', owner.cookie)
      .send({ windows: [noon] })
      .expect(200);

    const overlap = await http()
      .put(url)
      .set('Cookie', owner.cookie)
      .send({ windows: [noon, { ...noon, startMinute: 13 * 60 }] })
      .expect(400);
    expect(overlap.body.message).toEqual(['windows.1: Overlaps windows.0']);
    await http()
      .put(url)
      .set('Cookie', owner.cookie)
      .send({ windows: [{ ...noon, slotMinutes: 180 }] })
      .expect(400);

    await http()
      .get(overridesUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .expect(200)
      .expect([{ date: tuesday, windows: [noon] }]);
  });

  it('leave out dates before today', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    await app.get(PrismaService).dayOverride.create({
      data: { businessId: owner.business.id, staffId: anna, date: new Date('2020-01-07'), windows: [] },
    });

    await http().get(overridesUrl(owner.business.id, anna)).set('Cookie', owner.cookie).expect(200).expect([]);
  });

  it("may be changed by a master for their own schedule only, and read by them for anyone's", async () => {
    const owner = await signUpOwner(app);
    const master = await memberWithSchedule(owner.business.id, 'MASTER');
    const anna = await addStaff(owner);
    const put = (staffId: string) =>
      http()
        .put(`${overridesUrl(owner.business.id, staffId)}/${tuesday}`)
        .set('Cookie', master.cookie)
        .send({ windows: [] });

    await put(anna).expect(403);
    await http()
      .delete(`${overridesUrl(owner.business.id, anna)}/${tuesday}`)
      .set('Cookie', master.cookie)
      .expect(403);
    await put(master.staffId).expect(200);
    await http().get(overridesUrl(owner.business.id, anna)).set('Cookie', master.cookie).expect(200).expect([]);
  });

  it("answers 404 for another business's master", async () => {
    const owner = await signUpOwner(app);
    const elsewhere = await addStaff(await signUpOwner(app));

    await http().get(overridesUrl(owner.business.id, elsewhere)).set('Cookie', owner.cookie).expect(404);
    await http()
      .put(`${overridesUrl(owner.business.id, elsewhere)}/${tuesday}`)
      .set('Cookie', owner.cookie)
      .send({ windows: [] })
      .expect(404);
  });
});

describe('the mode of a schedule', () => {
  it('is HOURS for a new master and is changed by whoever may change the schedule', async () => {
    const owner = await signUpOwner(app);
    const master = await memberWithSchedule(owner.business.id, 'MASTER');
    const anna = await addStaff(owner);

    await http()
      .put(modeUrl(owner.business.id, master.staffId))
      .set('Cookie', master.cookie)
      .send({ mode: 'GROUPS' })
      .expect(200)
      .expect({ mode: 'GROUPS' });
    await http()
      .put(modeUrl(owner.business.id, anna))
      .set('Cookie', master.cookie)
      .send({ mode: 'GROUPS' })
      .expect(403);
    await http().put(modeUrl(owner.business.id, anna)).set('Cookie', owner.cookie).send({ mode: 'NONE' }).expect(400);

    const staff = await http().get(`/businesses/${owner.business.id}/staff`).set('Cookie', owner.cookie).expect(200);
    const modes = Object.fromEntries(
      staff.body.map((each: { id: string; scheduleMode: string }) => [each.id, each.scheduleMode]),
    );
    expect(modes).toMatchObject({ [master.staffId]: 'GROUPS', [anna]: 'HOURS' });
  });

  it("keeps the other mode's schedule, and the slots follow the mode", async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    await http()
      .put(weeklyUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .send({ windows: [window({ weekday: 2, durationMinutes: 60 })] }); // Tue 10:00 Moscow
    const group = await app.get(PrismaService).group.create({
      data: {
        businessId: owner.business.id,
        staffId: anna,
        title: 'Football',
        weekdays: [2],
        startMinute: 15 * 60,
        durationMinutes: 60,
        capacity: 4,
      },
    });
    const starts = async () =>
      (
        await http()
          .get(slotsUrl(owner.business.id))
          .query({ from: '2030-01-08', to: '2030-01-08' })
          .set('Cookie', owner.cookie)
          .expect(200)
      ).body.map((slot: { startsAt: string; groupId: string | null }) => [slot.startsAt, slot.groupId]);
    const setMode = (mode: string) =>
      http().put(modeUrl(owner.business.id, anna)).set('Cookie', owner.cookie).send({ mode }).expect(200);

    expect(await starts()).toEqual([['2030-01-08T07:00:00.000Z', null]]);
    await setMode('GROUPS');
    expect(await starts()).toEqual([['2030-01-08T12:00:00.000Z', group.id]]);
    await setMode('HOURS');
    expect(await starts()).toEqual([['2030-01-08T07:00:00.000Z', null]]);
  });
});

describe('the time off of a master', () => {
  const leave = { startsAt: '2030-01-07T08:00:00.000Z', endsAt: '2030-01-07T09:00:00.000Z' };

  it('is added, listed and removed, and refused when it ends before it starts', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const url = timeOffUrl(owner.business.id, anna);

    const created = await http()
      .post(url)
      .set('Cookie', owner.cookie)
      .send({ ...leave, note: 'Dentist' })
      .expect(201);
    expect(created.body).toEqual({ id: expect.any(String), staffId: anna, ...leave, note: 'Dentist' });
    await http().get(url).set('Cookie', owner.cookie).expect(200).expect([created.body]);
    await http()
      .post(url)
      .set('Cookie', owner.cookie)
      .send({ startsAt: leave.endsAt, endsAt: leave.startsAt })
      .expect(400);

    await http().delete(`${url}/${created.body.id}`).set('Cookie', owner.cookie).expect(204);
    await http().get(url).set('Cookie', owner.cookie).expect(200).expect([]);
  });

  it("can't be removed through another master's address", async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const boris = await addStaff(owner, 'Boris');
    const created = await http().post(timeOffUrl(owner.business.id, anna)).set('Cookie', owner.cookie).send(leave);

    await http()
      .delete(`${timeOffUrl(owner.business.id, boris)}/${created.body.id}`)
      .set('Cookie', owner.cookie)
      .expect(404);
  });

  it("can't be set by a master on someone else's schedule", async () => {
    const owner = await signUpOwner(app);
    const master = await memberWithSchedule(owner.business.id, 'MASTER');
    const anna = await addStaff(owner);

    await http().post(timeOffUrl(owner.business.id, anna)).set('Cookie', master.cookie).send(leave).expect(403);
    await http()
      .post(timeOffUrl(owner.business.id, master.staffId))
      .set('Cookie', master.cookie)
      .send(leave)
      .expect(201);
  });
});

describe("a master and someone else's schedule", () => {
  it('may read it and change none of it', async () => {
    const owner = await signUpOwner(app);
    const master = await memberWithSchedule(owner.business.id, 'MASTER');
    const anna = await addStaff(owner);
    const leave = { startsAt: '2030-01-07T08:00:00.000Z', endsAt: '2030-01-07T09:00:00.000Z' };
    const timeOff = await http().post(timeOffUrl(owner.business.id, anna)).set('Cookie', owner.cookie).send(leave);
    const as = (req: request.Test) => req.set('Cookie', master.cookie).expect(403);

    await as(
      http()
        .put(weeklyUrl(owner.business.id, anna))
        .send({ windows: [window()] }),
    );
    await as(http().post(timeOffUrl(owner.business.id, anna)).send(leave));
    await as(http().delete(`${timeOffUrl(owner.business.id, anna)}/${timeOff.body.id}`));

    await http()
      .get(timeOffUrl(owner.business.id, anna))
      .set('Cookie', master.cookie)
      .expect(200)
      .expect([timeOff.body]);
    await http()
      .get(weeklyUrl(owner.business.id, anna))
      .set('Cookie', master.cookie)
      .expect(200)
      .expect({ windows: [] });
  });
});

describe('a date that is no date', () => {
  it('is a 400 with the field named, not a 500, on every route that takes one', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const valid = '2030-01-08T14:00:00.000Z';

    const slots = await http()
      .get(slotsUrl(owner.business.id))
      .query({ from: 'zzz', to: 'abc' })
      .set('Cookie', owner.cookie)
      .expect(400);
    expect(slots.body.message).toEqual([expect.stringMatching(/^from: /), expect.stringMatching(/^to: Invalid/)]);
    const override = await http()
      .put(`${overridesUrl(owner.business.id, anna)}/2030-02-30`)
      .set('Cookie', owner.cookie)
      .send({ windows: [] })
      .expect(400);
    expect(override.body.message).toEqual(['Invalid ISO date']); // a path parameter has no field path, like :staffId
    const timeOff = await http()
      .post(timeOffUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .send({ startsAt: 'x', endsAt: valid })
      .expect(400);
    expect(timeOff.body.message).toEqual([expect.stringMatching(/^startsAt: /)]);
  });
});

describe('the free slots of a business', () => {
  it('are the windows of its masters minus time off, on the days asked', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const boris = await addStaff(owner, 'Boris');
    await http()
      .put(weeklyUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .send({ windows: [window()] }); // Mon 10:00–13:00 Moscow, hourly
    await http()
      .put(weeklyUrl(owner.business.id, boris))
      .set('Cookie', owner.cookie)
      .send({ windows: [window({ weekday: 2, startMinute: 1020, durationMinutes: 60, title: 'Football' })] });
    await http()
      .post(timeOffUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .send({ startsAt: '2030-01-07T08:00:00.000Z', endsAt: '2030-01-07T09:00:00.000Z' }); // 11:00–12:00

    const res = await http()
      .get(slotsUrl(owner.business.id))
      .query({ from: monday, to: '2030-01-08' })
      .set('Cookie', owner.cookie)
      .expect(200);

    expect(res.body).toEqual([
      {
        staffId: anna,
        startsAt: '2030-01-07T07:00:00.000Z',
        endsAt: '2030-01-07T08:00:00.000Z',
        title: null,
        ...oneSeat,
      },
      {
        staffId: anna,
        startsAt: '2030-01-07T09:00:00.000Z',
        endsAt: '2030-01-07T10:00:00.000Z',
        title: null,
        ...oneSeat,
      },
      {
        staffId: boris,
        startsAt: '2030-01-08T14:00:00.000Z',
        endsAt: '2030-01-08T15:00:00.000Z',
        title: 'Football',
        ...oneSeat,
      },
    ]);
    await http()
      .get(slotsUrl(owner.business.id))
      .query({ from: monday, to: '2030-01-08', staffId: boris })
      .set('Cookie', owner.cookie)
      .expect(200)
      .expect([res.body[2]]);
  });

  it('start from now: a day in the past has none, and the lists skip what is over', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    await http()
      .put(weeklyUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .send({ windows: [window()] });
    const past = {
      businessId: owner.business.id,
      staffId: anna,
      startsAt: new Date('2020-01-06T07:00:00Z'),
      endsAt: new Date('2020-01-06T08:00:00Z'),
    };
    await app.get(PrismaService).timeOff.create({ data: past });

    await http()
      .get(slotsUrl(owner.business.id))
      .query({ from: '2020-01-06', to: '2020-01-06' })
      .set('Cookie', owner.cookie)
      .expect(200)
      .expect([]);
    await http().get(timeOffUrl(owner.business.id, anna)).set('Cookie', owner.cookie).expect(200).expect([]);
  });

  it('leave out masters who left the team', async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    await http()
      .put(weeklyUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .send({ windows: [window()] });
    await http()
      .patch(`/businesses/${owner.business.id}/staff/${anna}`)
      .set('Cookie', owner.cookie)
      .send({ archived: true })
      .expect(200);

    await http()
      .get(slotsUrl(owner.business.id))
      .query({ from: monday, to: monday })
      .set('Cookie', owner.cookie)
      .expect(200)
      .expect([]);
  });

  it('are asked for at most 31 days at a time, to on or after from', async () => {
    const owner = await signUpOwner(app);
    const ask = (query: Record<string, string>) =>
      http().get(slotsUrl(owner.business.id)).query(query).set('Cookie', owner.cookie);

    await ask({ from: monday, to: '2030-02-06' }).expect(200);
    await ask({ from: monday, to: '2030-02-07' }).expect(400);
    await ask({ from: monday, to: '2030-01-06' }).expect(400);
    await ask({ from: '2030-02-30', to: '2030-03-01' }).expect(400);
  });
});
