import { PasswordHasher } from '@nestjs/authentication';
import { ConflictException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { violatedUniqueConstraint } from '../prisma/unique-violation.js';
import type { SignUpConflict, SignUpInput, SignUpResult } from './sign-up.schema.js';

// Which form field a taken unique value belongs to (constraint names from the init migration).
const TAKEN_FIELD: Record<string, SignUpConflict['field']> = {
  users_email_key: 'email',
  businesses_slug_key: 'slug',
};

@Injectable()
export class SignUpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
  ) {}

  // One nested write, so one transaction: the user, their password, the business and the
  // OWNER membership exist together or not at all (the database refuses a business
  // without its owner anyway).
  async signUp({ email, password, name, business }: SignUpInput): Promise<SignUpResult> {
    const passwordHash = await this.hasher.hash(password);

    try {
      const user = await this.prisma.user.create({
        data: {
          email,
          name,
          passwordLogin: { create: { passwordHash } },
          memberships: { create: { role: 'OWNER', business: { create: business } } },
        },
        select: {
          id: true,
          email: true,
          name: true,
          memberships: { select: { business: { select: { id: true, name: true, slug: true, timeZone: true } } } },
        },
      });
      const { memberships, ...account } = user;
      return { user: account, business: memberships[0].business };
    } catch (error) {
      const constraint = violatedUniqueConstraint(error);
      const field = constraint ? TAKEN_FIELD[constraint] : undefined;
      if (field) {
        // Telling that an email is registered is the usual trade-off for sign-up; sign-in
        // must not (see AGENTS.md).
        const body: SignUpConflict = {
          statusCode: 409,
          error: 'Conflict',
          message: field === 'email' ? 'This email is already registered' : 'This address is already taken',
          field,
        };
        throw new ConflictException(body);
      }
      throw error;
    }
  }
}
