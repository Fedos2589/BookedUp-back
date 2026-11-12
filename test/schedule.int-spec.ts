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
const groupsUrl = (businessId: string, staffId: string) => `${staffUrl(businessId, staffId)}/groups`;
const sessionsUrl = (businessId: string, staffId: string) => `${staffUrl(businessId, staffId)}/one-off-sessions`;
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

describe('the groups of a master', () => {
  // Tue and Thu 15:00–16:00 Moscow (12:00–13:00 UTC).
  const football = {
    title: 'Football, kids 7–10',
    description: 'Bring water and shin guards',
    weekdays: [4, 2],
    startMinute: 15 * 60,
    durationMinutes: 60,
    capacity: 12,
  };
  const masterclass = {
    title: 'Masterclass',
    startsAt: '2030-01-08T12:30:00.000Z', // Tue 15:30 Moscow
    endsAt: '2030-01-08T14:00:00.000Z',
    capacity: 30,
  };

  const coach = async () => {
    const owner = await signUpOwner(app);
    const anna = await addStaff(owner);
    const as = (req: request.Test) => req.set('Cookie', owner.cookie);
    return {
      owner,
      anna,
      as,
      groups: groupsUrl(owner.business.id, anna),
      sessions: sessionsUrl(owner.business.id, anna),
    };
  };

  it('are added, listed with their cancellations, changed and removed', async () => {
    const { as, groups } = await coach();

    const added = await as(http().post(groups).send(football)).expect(201);
    expect(added.body).toEqual({ id: expect.any(String), ...football, weekdays: [2, 4], cancellations: [] });
    const url = `${groups}/${added.body.id}`;

    await as(http().put(`${url}/cancellations/2030-01-08`)).expect(200);
    await as(http().put(`${url}/cancellations/2030-01-08`)).expect(200); // again: still one
    await as(http().put(`${url}/cancellations/2030-01-09`)).expect(400); // a Wednesday: it doesn't meet
    await as(http().get(groups))
      .expect(200)
      .expect([{ ...added.body, cancellations: ['2030-01-08'] }]);

    const changed = { ...football, description: null, capacity: 4 };
    await as(http().put(url).send(changed))
      .expect(200)
      .expect({ ...added.body, ...changed, weekdays: [2, 4], cancellations: ['2030-01-08'] });

    await as(http().delete(`${url}/cancellations/2030-01-08`)).expect(204);
    await as(http().delete(`${url}/cancellations/2030-01-08`)).expect(404);
    await as(http().delete(url)).expect(204);
    await as(http().get(groups)).expect(200).expect([]);
  });

  it('drop the cancellations of days a changed group no longer meets on', async () => {
    const { as, groups } = await coach();
    const group = await as(http().post(groups).send(football)).expect(201);
    const url = `${groups}/${group.body.id}`;
    await as(http().put(`${url}/cancellations/2030-01-08`)).expect(200); // a Tuesday
    await as(http().put(`${url}/cancellations/2030-01-10`)).expect(200); // a Thursday

    await as(
      http()
        .put(url)
        .send({ ...football, weekdays: [3, 4] }),
    )
      .expect(200)
      .expect({ ...group.body, weekdays: [3, 4], cancellations: ['2030-01-10'] });
    // Back on Tuesdays: the old Tuesday is not cancelled again by itself.
    await as(http().put(url).send(football))
      .expect(200)
      .expect({ ...group.body, cancellations: ['2030-01-10'] });
  });

  it('refuse a group that meets at the time of another with 409 naming it', async () => {
    const { as, groups } = await coach();
    const first = await as(http().post(groups).send(football)).expect(201);

    const res = await as(
      http()
        .post(groups)
        .send({ ...football, title: 'Tennis', weekdays: [4, 6], startMinute: 15 * 60 + 30 }),
    ).expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Overlaps «Football, kids 7–10»',
      field: 'startMinute',
      conflictsWith: { kind: 'group', id: first.body.id, title: 'Football, kids 7–10', date: null },
    });
    await as(
      http()
        .post(groups)
        .send({ ...football, title: 'Tennis', weekdays: [5] }),
    ).expect(201);
  });

  it('take a one-off session over a meeting only once that date is cancelled', async () => {
    const { as, groups, sessions } = await coach();
    const group = await as(http().post(groups).send(football)).expect(201);

    const res = await as(http().post(sessions).send(masterclass)).expect(409);
    expect(res.body).toMatchObject({
      field: 'startsAt',
      conflictsWith: { kind: 'group', id: group.body.id, date: '2030-01-08' },
    });

    await as(http().put(`${groups}/${group.body.id}/cancellations/2030-01-08`)).expect(200);
    const session = await as(http().post(sessions).send(masterclass)).expect(201);
    expect(session.body).toEqual({ id: expect.any(String), ...masterclass, description: null });

    // Un-cancelling would put the meeting under the session: refused, the cancellation stays.
    const undo = await as(http().delete(`${groups}/${group.body.id}/cancellations/2030-01-08`)).expect(409);
    expect(undo.body).toMatchObject({ field: 'date', conflictsWith: { kind: 'oneOffSession', id: session.body.id } });
    await as(http().get(groups))
      .expect(200)
      .expect([{ ...group.body, cancellations: ['2030-01-08'] }]);
  });

  it('refuse moving a group onto a one-off session', async () => {
    const { as, groups, sessions } = await coach();
    const group = await as(
      http()
        .post(groups)
        .send({ ...football, startMinute: 18 * 60 }),
    ).expect(201);
    await as(http().post(sessions).send(masterclass)).expect(201);

    const res = await as(http().put(`${groups}/${group.body.id}`).send(football)).expect(409);
    expect(res.body).toMatchObject({ field: 'startMinute', conflictsWith: { kind: 'oneOffSession' } });
  });

  it('give one 201 and one 409 when two one-off sessions race for one time', async () => {
    const { as, sessions } = await coach();

    const answers = await Promise.all([
      as(http().post(sessions).send(masterclass)),
      as(http().post(sessions).send(masterclass)),
    ]);

    expect(answers.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(answers.find((res) => res.status === 409)?.body).toMatchObject({ conflictsWith: { kind: 'oneOffSession' } });
  });

  it('give one 201 and one 409 when a group and a session race for one time', async () => {
    // Five pairs, each on its own master: without the staff row's lock both would go in.
    const pairs = await Promise.all(
      [1, 2, 3, 4, 5].map(async () => {
        const { as, groups, sessions } = await coach();
        return Promise.all([as(http().post(groups).send(football)), as(http().post(sessions).send(masterclass))]);
      }),
    );

    for (const answers of pairs) expect(answers.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 409]);
  });

  it('list the cancellations of a group from today on', async () => {
    const { owner, as, groups } = await coach();
    const group = await as(http().post(groups).send(football)).expect(201);
    await app.get(PrismaService).groupCancellation.create({
      data: { businessId: owner.business.id, groupId: group.body.id, date: new Date('2020-01-07') },
    });

    await as(http().get(groups)).expect(200).expect([group.body]);
  });

  it('refuse a bad field with 400', async () => {
    const { as, groups, sessions } = await coach();
    const refused = async (url: string, body: object, field: string) => {
      const res = await as(http().post(url).send(body)).expect(400);
      expect(res.body.message).toEqual([expect.stringMatching(new RegExp(`^${field}: `))]);
    };

    await refused(groups, { ...football, capacity: 0 }, 'capacity');
    await refused(groups, { ...football, capacity: 1001 }, 'capacity');
    await refused(groups, { ...football, weekdays: [] }, 'weekdays');
    await refused(groups, { ...football, title: 'x'.repeat(101) }, 'title');
    await refused(groups, { ...football, title: '  ' }, 'title');
    await refused(groups, { ...football, description: 'x'.repeat(2001) }, 'description');
    await refused(sessions, { ...masterclass, endsAt: masterclass.startsAt }, 'endsAt');
    await refused(sessions, { ...masterclass, endsAt: '2030-01-09T13:00:00.000Z' }, 'endsAt');
    await refused(sessions, { ...masterclass, startsAt: 'x' }, 'startsAt');
  });

  it('list one-off sessions not over yet, earliest first, and remove them', async () => {
    const { owner, anna, as, sessions } = await coach();
    await app.get(PrismaService).oneOffSession.create({
      data: {
        businessId: owner.business.id,
        staffId: anna,
        title: 'Old',
        startsAt: new Date('2020-01-07T12:00:00Z'),
        endsAt: new Date('2020-01-07T13:00:00Z'),
        capacity: 5,
      },
    });
    const later = await as(
      http()
        .post(sessions)
        .send({ ...masterclass, startsAt: '2030-01-09T12:00:00.000Z', endsAt: '2030-01-09T13:00:00.000Z' }),
    ).expect(201);
    const sooner = await as(http().post(sessions).send(masterclass)).expect(201);

    await as(http().get(sessions)).expect(200).expect([sooner.body, later.body]);
    await as(http().delete(`${sessions}/${sooner.body.id}`)).expect(204);
    await as(http().delete(`${sessions}/${sooner.body.id}`)).expect(404);
  });

  it('are changed by a master on their own schedule only', async () => {
    const owner = await signUpOwner(app);
    const master = await memberWithSchedule(owner.business.id, 'MASTER');
    const anna = await addStaff(owner);
    const group = await http()
      .post(groupsUrl(owner.business.id, anna))
      .set('Cookie', owner.cookie)
      .send(football)
      .expect(201);
    const as = (req: request.Test) => req.set('Cookie', master.cookie);
    const annas = `${groupsUrl(owner.business.id, anna)}/${group.body.id}`;

    await as(http().post(groupsUrl(owner.business.id, anna)).send(football)).expect(403);
    await as(http().put(annas).send(football)).expect(403);
    await as(http().delete(annas)).expect(403);
    await as(http().put(`${annas}/cancellations/2030-01-08`)).expect(403);
    await as(http().post(sessionsUrl(owner.business.id, anna)).send(masterclass)).expect(403);
    await as(http().get(groupsUrl(owner.business.id, anna))).expect(200);
    await as(http().post(groupsUrl(owner.business.id, master.staffId)).send(football)).expect(201);
  });

  it("can't be reached through another master's or another business's address", async () => {
    const { owner, as, groups } = await coach();
    const boris = await addStaff(owner, 'Boris');
    const group = await as(http().post(groups).send(football)).expect(201);
    const elsewhere = await addStaff(await signUpOwner(app));
    const borisUrl = `${groupsUrl(owner.business.id, boris)}/${group.body.id}`;

    await as(http().put(borisUrl).send(football)).expect(404);
    await as(http().delete(borisUrl)).expect(404);
    await as(http().put(`${borisUrl}/cancellations/2030-01-08`)).expect(404);
    await as(http().get(groupsUrl(owner.business.id, elsewhere))).expect(404);
    await as(http().get(sessionsUrl(owner.business.id, elsewhere))).expect(404);
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
