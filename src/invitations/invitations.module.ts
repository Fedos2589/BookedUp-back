import { Module } from '@nestjs/common';

import { AccountModule } from '../account/account.module.js';
import { InvitationLinkController } from './invitation-link.controller.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  imports: [AccountModule],
  controllers: [InvitationsController, InvitationLinkController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
