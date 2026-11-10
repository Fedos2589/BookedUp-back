import { PasswordHasher } from '@nestjs/authentication';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
  ) {}

  // The user's id, or null when the email or the password is wrong. An unknown email and
  // an account without a password still pay for one hash (verify() checks a dummy), so
  // neither the answer nor its timing tells which emails are registered.
  async verify(email: string, password: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordLogin: { select: { passwordHash: true } } },
    });
    const hash = user?.passwordLogin?.passwordHash;
    if (!(await this.hasher.verify(password, hash)) || !user || !hash) return null;

    // The cost was raised since this hash was made: upgrade it while we have the password.
    if (this.hasher.needsRehash(hash)) {
      await this.prisma.passwordLogin.update({
        where: { userId: user.id },
        data: { passwordHash: await this.hasher.hash(password) },
      });
    }
    return user.id;
  }
}
