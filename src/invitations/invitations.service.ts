import { AuthorizationService } from '@nestjs/authorization';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthUser } from '../auth/auth-types.js';
import { BusinessPolicy } from '../business/business.policy.js';
import type { Env } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { assignableRoleSchema } from '../members/members.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashInvitationToken, newInvitationToken } from './invitation-token.js';
import type { CreatedInvitation, CreateInvitationInput, InvitationView } from './invitations.schema.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const invitationSelect = {
  id: true,
  role: true,
  note: true,
  staffId: true,
  expiresAt: true,
  createdAt: true,
  invitedBy: { select: { name: true } },
} as const;

type InvitationRow = Prisma.InvitationGetPayload<{ select: typeof invitationSelect }>;

// The role is parsed, not cast: the database's CHECK keeps OWNER out, and this says so to the types.
const toView = ({ invitedBy, expiresAt, createdAt, role, ...rest }: InvitationRow): InvitationView => ({
  ...rest,
  role: assignableRoleSchema.parse(role),
  invitedBy: invitedBy?.name ?? null,
  expiresAt: expiresAt.toISOString(),
  createdAt: createdAt.toISOString(),
});

// Still good: neither accepted nor revoked, and not expired at `now`.
export const pendingAt = (now: Date) => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: now } });

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // The link is in the answer and in the log: no email is sent yet (E3 decision), so the
  // inviter passes it on, and in development it can be picked up from the log.
  async create(actor: AuthUser, businessId: string, input: CreateInvitationInput): Promise<CreatedInvitation> {
    await this.authorization.authorize(BusinessPolicy, 'manageRole', actor, businessId, input.role);
    if (input.staffId) await this.assertFreeSchedule(businessId, input.staffId);

    const token = newInvitationToken();
    const invitation = toView(
      await this.prisma.invitation.create({
        data: {
          businessId,
          ...input,
          invitedById: actor.id,
          tokenHash: hashInvitationToken(token),
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
        select: invitationSelect,
      }),
    );
    const link = new URL(`/invite/${token}`, this.config.get('APP_URL', { infer: true })).href;
    this.logger.log({ businessId, invitationId: invitation.id, link }, 'Invitation created');
    return { invitation, link };
  }

  async listPending(businessId: string): Promise<InvitationView[]> {
    const invitations = await this.prisma.invitation.findMany({
      where: { businessId, ...pendingAt(new Date()) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: invitationSelect,
    });
    return invitations.map(toView);
  }

  // Idempotent: an invitation already revoked (or expired) answers the same. One already
  // accepted is a member now: removing them is DELETE /members/:userId.
  async revoke(actor: AuthUser, businessId: string, invitationId: string): Promise<void> {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, businessId },
      select: { role: true },
    });
    if (!invitation) throw new NotFoundException();
    await this.authorization.authorize(BusinessPolicy, 'manageRole', actor, businessId, invitation.role);

    const { count } = await this.prisma.invitation.updateMany({
      where: { id: invitationId, businessId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count > 0) return;
    const { acceptedAt } = await this.prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { acceptedAt: true },
    });
    if (acceptedAt) throw new ConflictException('This invitation is already accepted');
  }

  // Checked here for a clear 400. Accepting links the schedule only while it has no account,
  // so a schedule taken in between fails there, not silently here.
  private async assertFreeSchedule(businessId: string, staffId: string): Promise<void> {
    const free = await this.prisma.staff.count({ where: { id: staffId, businessId, userId: null, archivedAt: null } });
    if (!free) throw new BadRequestException(['staffId: Not a schedule without an account in this business']);
  }
}
