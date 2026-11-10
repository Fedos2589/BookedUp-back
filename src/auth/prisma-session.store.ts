import { AuthenticationStorage, type SessionRecord, type SessionStore } from '@nestjs/authentication';
import { Injectable, Logger } from '@nestjs/common';

import type { Session } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import './auth-types.js';

const userColumns = { id: true, email: true, name: true } as const;

// Sessions for @nestjs/authentication, in Postgres. Every method that decides something
// happens once is one conditional statement (see the SessionStore doc comments), so the
// rules hold with any number of API instances; test/session-store.int-spec.ts runs the
// package's contract suite, races included.
@Injectable()
export class PrismaSessionStore implements SessionStore {
  private readonly logger = new Logger(PrismaSessionStore.name);

  constructor(
    private readonly prisma: PrismaService,
    storage: AuthenticationStorage,
  ) {
    storage.registerSource({ sessions: this });
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = await this.prisma.session.findUnique({ where: { id }, include: { user: { select: userColumns } } });
    if (!row) return undefined;
    const { user, ...session } = row;
    return { ...toRecord(session), extra: user };
  }

  async createSession({ metadata, mfa, ...record }: SessionRecord): Promise<void> {
    await this.prisma.session.create({
      data: { ...record, ...(mfa && { mfa }), ...(metadata && { metadata: metadata as object }) },
    });
    // Keeps the table bounded: whoever signs in sweeps the sessions past their absolute
    // expiry (the contract allows no more: the store doesn't know the idle timeout). Best
    // effort: the cookie is set only after this resolves, so a failed sweep of other
    // people's sessions must not fail the sign-in.
    await this.prisma.session
      .deleteMany({ where: { expiresAt: { lte: record.createdAt } } })
      .catch((error: unknown) => this.logger.warn({ err: error }, 'Sweeping expired sessions failed'));
  }

  async touchSession(id: string, lastActiveAt: Date): Promise<void> {
    // Conditional: a session deleted by a sign-out stays deleted, and time only moves forward.
    await this.prisma.session.updateMany({ where: { id, lastActiveAt: { lt: lastActiveAt } }, data: { lastActiveAt } });
  }

  async deleteSession(id: string): Promise<boolean> {
    // The row count says whether this call won: of two rotations, or a rotation and a sign-out, one does.
    const { count } = await this.prisma.session.deleteMany({ where: { id } });
    return count > 0;
  }

  async listUserSessions(userId: string): Promise<SessionRecord[]> {
    const rows = await this.prisma.session.findMany({ where: { userId } });
    return rows.map(toRecord);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId } });
  }
}

// Optional fields come back absent, never null (the contract).
function toRecord({ mfa, metadata, ...session }: Session): SessionRecord {
  return {
    ...session,
    ...(mfa && { mfa }),
    ...(metadata !== null && { metadata: metadata as Record<string, unknown> }),
  };
}
