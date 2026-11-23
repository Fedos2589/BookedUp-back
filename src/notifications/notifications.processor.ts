import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';

import type { Env } from '../config/env.js';
import { DispatcherService } from './dispatcher.service.js';
import { RemindersService } from './reminders.service.js';

export const NOTIFICATIONS_QUEUE = 'notifications';

const TICK_EVERY_MS = 30_000;

// One repeating job feeds the whole pipeline: reminders come due, events become deliveries, deliveries go out.
// The worker is created by `autorun: false` stopped: only a process with NOTIFICATIONS_WORKER on starts it
// (and puts the schedule in Redis), so tests and extra API replicas never pull a job.
@Processor(NOTIFICATIONS_QUEUE, { autorun: false })
export class NotificationsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly reminders: RemindersService,
    private readonly dispatcher: DispatcherService,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // After every module's init: the worker is made by then.
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('NOTIFICATIONS_WORKER', { infer: true })) return;
    // 2880 ticks a day: the finished ones are not kept (BullMQ keeps them all by default).
    await this.queue.upsertJobScheduler(
      'tick',
      { every: TICK_EVERY_MS },
      { name: 'tick', opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    this.worker.run().catch((err: unknown) => this.logger.error({ err }, 'The notifications worker stopped'));
  }

  async process(): Promise<void> {
    const now = new Date();
    // Reminders that can't be written must not hold back the other messages: they are retried on the next tick.
    try {
      await this.reminders.scheduleReminders(now);
    } catch (err) {
      this.logger.error({ err }, 'Scheduling reminders failed');
    }
    await this.dispatcher.dispatch(now);
  }
}
