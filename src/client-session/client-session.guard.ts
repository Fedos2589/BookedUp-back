import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { ClientCookies } from './client-cookies.js';
import { type ClientSession, ClientSessionsService } from './client-sessions.service.js';

export type ClientRequest = Request & { clientSession: ClientSession };

export const clientSignIn = () =>
  new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'Confirm your phone first',
    code: 'clientSignIn',
  });

// The client's identity on the public pages comes only from here, never from the cabinet's session.
@Injectable()
export class ClientSessionGuard implements CanActivate {
  constructor(
    private readonly sessions: ClientSessionsService,
    private readonly cookies: ClientCookies,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ClientRequest>();
    const token = this.cookies.sessionOf(req);
    const session = token === undefined ? null : await this.sessions.find(token);
    if (!session) throw clientSignIn();
    req.clientSession = session;
    return true;
  }
}
