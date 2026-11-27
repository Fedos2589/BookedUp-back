import { PasswordHasher } from '@nestjs/authentication';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type Locale, localeSchema } from '../account/locale.js';
import { hashRandomToken, newRandomToken } from '../common/random-token.js';
import type { Env } from '../config/env.js';
import { Mailer } from '../mail/mailer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { passwordResetLink, passwordResetMail } from './password-reset-mail.js';

const LINK_LIFETIME_MS = 60 * 60 * 1000;
// A user gets at most one letter a minute: a newer request inside it is dropped silently.
const COOLDOWN_MS = 60 * 1000;

const resetLinkInvalid = () =>
  new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    message: 'This link does not work: it is used, expired or wrong',
    code: 'resetLinkInvalid',
  });

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly hasher: PasswordHasher,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Answers nothing about the email: the caller says 204 either way. The letter is sent after the commit and not
  // awaited, so a slow mail service doesn't hold the request; a lost letter costs one more press of the button.
  async request(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, locale: true } });
    if (!user) return;

    const token = newRandomToken();
    const issued = await this.prisma.$transaction(async (tx) => {
      // Two parallel requests would both pass a read-then-write cooldown and leave two working links.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${user.id}::text, 0))`;
      const recent = await tx.passwordReset.findFirst({
        where: { userId: user.id, createdAt: { gt: new Date(Date.now() - COOLDOWN_MS) } },
        select: { id: true },
      });
      if (recent) return false;
      await tx.passwordReset.deleteMany({ where: { userId: user.id } });
      await tx.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: hashRandomToken(token),
          expiresAt: new Date(Date.now() + LINK_LIFETIME_MS),
        },
      });
      return true;
    });
    if (!issued) return;

    const locale = localeSchema.catch('en').parse(user.locale);
    void this.deliver(email, locale, token).catch((error: unknown) =>
      this.logger.warn({ err: error }, 'Sending the password reset letter failed'),
    );
  }

  private async deliver(email: string, locale: Locale, token: string): Promise<void> {
    const link = passwordResetLink(this.config.get('APP_URL', { infer: true }), token);
    if (this.mailer.isOn()) {
      await this.mailer.send({ to: email, ...passwordResetMail(locale, link) });
    } else if (this.config.get('NODE_ENV', { infer: true }) === 'production') {
      this.logger.warn('email is off: password reset letter not sent');
    } else {
      this.logger.log({ link }, 'password reset link');
    }
  }

  // The link is spent by one DELETE … RETURNING, so of two confirms with one token only one gets the row. The new
  // password replaces the old one, and every session and link of the user goes: whoever knew the old password is out.
  async confirm(token: string, password: string): Promise<void> {
    const passwordHash = await this.hasher.hash(password);
    await this.prisma.$transaction(async (tx) => {
      const spent = await tx.$queryRaw<{ user_id: string }[]>`
        DELETE FROM password_resets WHERE token_hash = ${hashRandomToken(token)} AND expires_at > now()
        RETURNING user_id::text`;
      const userId = spent[0]?.user_id;
      if (userId === undefined) throw resetLinkInvalid();
      await tx.passwordLogin.upsert({
        where: { userId },
        create: { userId, passwordHash },
        update: { passwordHash },
      });
      await tx.session.deleteMany({ where: { userId } });
      await tx.passwordReset.deleteMany({ where: { userId } });
    });
  }
}
