import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { ClientRequest } from './client-session.guard.js';
import type { ClientSession } from './client-sessions.service.js';

// The session `ClientSessionGuard` found; use only on a route with that guard.
export const CurrentClient = createParamDecorator(
  (_: unknown, context: ExecutionContext): ClientSession =>
    context.switchToHttp().getRequest<ClientRequest>().clientSession,
);
