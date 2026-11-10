import { type AuthorizationEvent, AuthorizationEvents } from '@nestjs/authorization';
import { Controller, Get, type INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { BusinessPolicy, MemberOfBusiness } from '../src/business/business.policy.js';
import { BusinessService } from '../src/business/business.service.js';
import { signUpOwner } from './helpers.js';
import { createTestApp } from './test-app.js';

// Test-only routes: what the global guard does with a handler that declares no check,
// and with a membership check on a route whose param is not named :businessId.
@Controller('test-only/unchecked')
class UncheckedController {
  @Get()
  get() {
    return 'open';
  }
}

@MemberOfBusiness()
@Controller('test-only/misnamed/:id')
class MisnamedParamController {
  @Get()
  get() {
    return 'open';
  }
}

let app: INestApplication<App>;

const http = () => request(app.getHttpServer());

const getBusiness = (businessId: string, cookie?: string) => {
  const req = http().get(`/businesses/${businessId}`);
  return cookie ? req.set('Cookie', cookie) : req;
};

// Every route of the app whose path has :businessId, as { method: 'get', path: '/businesses/:businessId/...' }.
const businessRoutes = () => {
  const scanner = new MetadataScanner();
  return app
    .get(DiscoveryService)
    .getControllers()
    .flatMap(({ metatype, instance }) => {
      if (!metatype || !instance) return [];
      // @Controller() and @Get() take one path or several.
      const bases = [(Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined) ?? ''].flat();
      return scanner.getAllMethodNames(Object.getPrototypeOf(instance)).flatMap((name) => {
        const handler = (instance as Record<string, unknown>)[name] as object;
        const paths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        if (paths === undefined) return [];
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod].toLowerCase();
        return bases
          .flatMap((base) =>
            [paths].flat().map((path) => `/${base}/${path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')),
          )
          .filter((path) => path.includes(':businessId'))
          .map((path) => ({ method, path }));
      });
    });
};

beforeAll(async () => {
  app = await createTestApp({ controllers: [UncheckedController, MisnamedParamController] });
});

afterAll(async () => {
  await app.close();
});

describe('access to a business', () => {
  it('lets a member in: GET /businesses/:businessId answers the business and their role', async () => {
    const owner = await signUpOwner(app);

    await getBusiness(owner.business.id, owner.cookie)
      .expect(200)
      .expect({ ...owner.business, role: 'OWNER' });
  });

  // Stopped by the guard, before the handler: the service's own scoping is a second line, not the check.
  // The spy sits on the service the handler calls: Nest binds the controller method at startup,
  // so a spy on the controller instance never sees a call, and `not.toHaveBeenCalled()` would always pass.
  it("answers 403 to someone else's business, before the handler runs", async () => {
    const owner = await signUpOwner(app);
    const stranger = await signUpOwner(app);
    const handler = vi.spyOn(app.get(BusinessService), 'describe');

    try {
      await getBusiness(owner.business.id, stranger.cookie).expect(403);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      handler.mockRestore();
    }
  });

  // The same answer as for someone else's business: the response doesn't tell which ids exist.
  it('answers 403 to a business that does not exist, and to an id that is not a UUID', async () => {
    const { cookie } = await signUpOwner(app);

    await getBusiness(randomUUID(), cookie).expect(403);
    await getBusiness('not-a-uuid', cookie).expect(403);
  });

  it('answers 401 without a session', async () => {
    const owner = await signUpOwner(app);

    await getBusiness(owner.business.id).expect(401);
  });

  // The invariant behind the multi-tenancy rule, checked on every route rather than left to
  // review: a method's own @Public() or @Can.Anyone() lifts its class's @MemberOfBusiness(),
  // and a controller may forget the decorator altogether. A 403 alone proves nothing: the
  // service answers 403 too, possibly after it has changed something. So each route must be
  // refused by BusinessPolicy.member itself, as the guard reports in AuthorizationEvents.
  it('refuses a stranger by the membership check on every route under :businessId', async () => {
    const owner = await signUpOwner(app);
    const stranger = await signUpOwner(app);
    const routes = businessRoutes();
    expect(routes.length).toBeGreaterThan(0);

    const denials: AuthorizationEvent[] = [];
    const subscription = app.get(AuthorizationEvents).events$.subscribe((event) => denials.push(event));
    const answers: string[] = [];
    try {
      // One at a time, so the denials that arrive belong to this request.
      for (const { method, path } of routes) {
        const url = path.replace(':businessId', owner.business.id).replace(/:\w+/g, () => randomUUID());
        const before = denials.length;
        const res = await http()[method as 'get'](url).set('Cookie', stranger.cookie);
        const byMembership = denials
          .slice(before)
          .some(({ policy, ability }) => policy === BusinessPolicy.name && ability === 'member');
        answers.push(`${method} ${path} ${res.status}${byMembership ? '' : ' NOT by the membership check'}`);
      }
    } finally {
      subscription.unsubscribe();
    }

    expect(answers).toEqual(routes.map(({ method, path }) => `${method} ${path} 403`));
  });
});

describe('the authorization guard', () => {
  it('denies a handler that declares no check, even to a signed-in user', async () => {
    const { cookie } = await signUpOwner(app);

    await http().get('/test-only/unchecked').set('Cookie', cookie).expect(403);
  });

  // A programmer's mistake, not the user's: loud, not a 403 that looks like a stranger's.
  it('fails a membership check on a route without :businessId', async () => {
    const owner = await signUpOwner(app);

    await http().get(`/test-only/misnamed/${owner.business.id}`).set('Cookie', owner.cookie).expect(500);
  });
});
