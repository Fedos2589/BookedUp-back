import { Module } from '@nestjs/common';

import { Mailer } from './mailer.js';

@Module({ providers: [Mailer], exports: [Mailer] })
export class MailModule {}
