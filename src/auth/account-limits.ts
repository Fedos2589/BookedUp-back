import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hours, minutes, normalizeIp, type ThrottlerOptions } from '@nestjs/throttler';

import { accountEmail } from './account-email.js';

const COUNT_PER_ACCOUNT = Symbol('countPerAccount');

// Marks a route that checks a password for the account its body names: only such routes
// count against the per-account limits. Opt-in, so a future route with an email in its
// body (an invitation) isn't throttled by them by accident.
export const CountPerAccount = () => SetMetadata(COUNT_PER_ACCOUNT, true);

const reflector = new Reflector();
const skip = (context: ExecutionContext) =>
  !reflector.get<boolean>(COUNT_PER_ACCOUNT, context.getHandler()) ||
  !accountEmail(context.switchToHttp().getRequest());

export const accountLimits: ThrottlerOptions[] = [
  // One client guessing at one account.
  {
    name: 'account',
    ttl: minutes(15),
    limit: 5,
    skipIf: skip,
    getTracker: (req) => `${accountEmail(req)}|${normalizeIp(req.ip)}`,
  },
  // Many addresses guessing at one account. High, because anyone who knows the email can
  // use it up and keep the owner from signing in with a password for the rest of the hour.
  { name: 'email', ttl: hours(1), limit: 50, skipIf: skip, getTracker: (req) => accountEmail(req) },
];
