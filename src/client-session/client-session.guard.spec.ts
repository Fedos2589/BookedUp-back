import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';

import type { ClientCookies } from './client-cookies.js';
import { ClientSessionGuard } from './client-session.guard.js';
import type { ClientSessionsService } from './client-sessions.service.js';

const run = async (token: string | undefined, found: { id: string; phone: string; chatId: string } | null) => {
  const req: Record<string, unknown> = {};
  const sessions = { find: vi.fn(async () => found) };
  const cookies = { sessionOf: vi.fn(() => token), setSession: vi.fn() };
  const res = {};
  const guard = new ClientSessionGuard(
    sessions as unknown as ClientSessionsService,
    cookies as unknown as ClientCookies,
  );
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  const result = await guard.canActivate(context).then(
    (ok) => ({ ok }),
    (error: unknown) => ({ error }),
  );
  return { result, req, sessions, cookies, res };
};

describe('ClientSessionGuard', () => {
  it('puts the live session on the request', async () => {
    const session = { id: 's1', phone: '+79990001122', chatId: '5' };

    const { result, req, sessions, cookies, res } = await run('tok', session);

    expect(result).toEqual({ ok: true });
    expect(req.clientSession).toEqual(session);
    expect(sessions.find).toHaveBeenCalledWith('tok');
    expect(cookies.setSession).toHaveBeenCalledWith(res, 'tok');
  });

  it('is 401 clientSignIn without the cookie, without asking the table', async () => {
    const { result, sessions } = await run(undefined, null);

    expect(result).toMatchObject({ error: expect.any(UnauthorizedException) });
    expect((result as { error: UnauthorizedException }).error.getResponse()).toMatchObject({
      statusCode: 401,
      code: 'clientSignIn',
    });
    expect(sessions.find).not.toHaveBeenCalled();
  });

  it('is 401 clientSignIn when the session is not live', async () => {
    const { result, cookies } = await run('tok', null);

    expect((result as { error: UnauthorizedException }).error.getResponse()).toMatchObject({ code: 'clientSignIn' });
    expect(cookies.setSession).not.toHaveBeenCalled();
  });
});
