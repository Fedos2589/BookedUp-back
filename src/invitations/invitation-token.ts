import { createHash, randomBytes } from 'node:crypto';

// 256 random bits, URL-safe (43 characters): what the link carries. Only its hash is stored.
export const newInvitationToken = () => randomBytes(32).toString('base64url');

// What is stored and looked up: SHA-256, hex. A token is random, so no salt or slow hash is needed.
export const hashInvitationToken = (token: string) => createHash('sha256').update(token).digest('hex');
