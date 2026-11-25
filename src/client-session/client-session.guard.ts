import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

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
    const http = context.switchToHttp();
    const req = http.getRequest<ClientRequest>();
    const token = this.cookies.sessionOf(req);
    if (token === undefined) throw clientSignIn();
    const session = await this.sessions.find(token);
    if (!session) throw clientSignIn();
    req.clientSession = session;
    // The server's expiry slides, so the browser's cookie does too.
    this.cookies.setSession(http.getResponse<Response>(), token);
    return true;
  }
}
