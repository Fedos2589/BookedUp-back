import { appLink } from '../common/app-link.js';

// <appUrl>/invite/<token>
export const invitationLink = (appUrl: string, token: string) => appLink(appUrl, `invite/${token}`);
