import { Module } from '@nestjs/common';

import { AccountModule } from '../account/account.module.js';
import { MailModule } from '../mail/mail.module.js';
import { PasswordResetController } from './password-reset.controller.js';
import { PasswordResetService } from './password-reset.service.js';
import { CredentialsService } from './credentials.service.js';
import { PrismaSessionStore } from './prisma-session.store.js';
import { SessionAuth } from './session-auth.provider.js';
import { SessionController } from './session.controller.js';
import { SignUpController } from './sign-up.controller.js';
import { SignUpService } from './sign-up.service.js';

// PasswordHasher, SignInService and the global guard come from AuthenticationModule
// (AppModule); the store and the cookie provider register themselves with it.
@Module({
  imports: [AccountModule, MailModule],
  controllers: [SignUpController, SessionController, PasswordResetController],
  providers: [PrismaSessionStore, SessionAuth, CredentialsService, SignUpService, PasswordResetService],
})
export class AuthModule {}
