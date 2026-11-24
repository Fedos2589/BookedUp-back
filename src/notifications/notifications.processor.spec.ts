import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';

import type { Env } from '../config/env.js';
import type { LinkTokensService } from './link-tokens.service.js';
import type { DispatcherService } from './dispatcher.service.js';
import { NotificationsProcessor } from './notifications.processor.js';
import type { RemindersService } from './reminders.service.js';

const setUp = (workerOn: boolean) => {
  const calls: string[] = [];
  const nows: Date[] = [];
  const reminders = {
    scheduleReminders: vi.fn(async (now: Date) => {
      calls.push('reminders');
      nows.push(now);
      return 0;
    }),
  };
  const dispatcher = {
    dispatch: vi.fn(async (now: Date) => {
      calls.push('dispatch');
      nows.push(now);
    }),
  };
  const linkTokens = {
    purgeExpired: vi.fn(async () => {
      calls.push('purge');
      return 0;
    }),
  };
  const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
  const run = vi.fn().mockResolvedValue(undefined);
  const config = { get: vi.fn(() => workerOn) };
  const processor = new NotificationsProcessor(
    reminders as unknown as RemindersService,
    dispatcher as unknown as DispatcherService,
    linkTokens as unknown as LinkTokensService,
    config as unknown as ConfigService<Env, true>,
    queue as unknown as Queue,
  );
  Object.defineProperty(processor, 'worker', { get: () => ({ run }) });
  return { processor, calls, nows, queue, run, reminders, linkTokens };
};

describe('NotificationsProcessor', () => {
  it('schedules reminders, then dispatches, with one now', async () => {
    const { processor, calls, nows } = setUp(true);

    await processor.process();

    expect(calls).toEqual(['reminders', 'purge', 'dispatch']);
    expect(nows[0]).toBe(nows[1]);
  });

  it('still dispatches when scheduling reminders fails', async () => {
    const { processor, calls, reminders } = setUp(true);
    reminders.scheduleReminders.mockRejectedValueOnce(new Error('lock timeout'));

    await processor.process();

    expect(calls).toEqual(['purge', 'dispatch']);
  });

  it('still dispatches when deleting expired link tokens fails', async () => {
    const { processor, calls, linkTokens } = setUp(true);
    linkTokens.purgeExpired.mockRejectedValueOnce(new Error('connection lost'));

    await processor.process();

    expect(calls).toEqual(['reminders', 'dispatch']);
  });

  it('puts the 30-second schedule in and starts the worker when it is on', async () => {
    const { processor, queue, run } = setUp(true);

    await processor.onApplicationBootstrap();

    // The finished ticks don't pile up in Redis: 2880 a day.
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'tick',
      { every: 30_000 },
      { name: 'tick', opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it('touches neither the schedule nor the worker when it is off', async () => {
    const { processor, queue, run } = setUp(false);

    await processor.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
