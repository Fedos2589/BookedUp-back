import { Module } from '@nestjs/common';

import { InvitationLinkController } from './invitation-link.controller.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  controllers: [InvitationsController, InvitationLinkController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
