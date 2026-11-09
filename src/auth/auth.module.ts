import { PasswordHasher } from '@nestjs/authentication';
import { Module } from '@nestjs/common';

import { SignUpController } from './sign-up.controller.js';
import { SignUpService } from './sign-up.service.js';

@Module({
  controllers: [SignUpController],
  // scrypt with the package's OWASP defaults; tests swap in a cheaper one.
  providers: [SignUpService, { provide: PasswordHasher, useValue: new PasswordHasher() }],
})
export class AuthModule {}
