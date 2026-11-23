import { appLink } from '../common/app-link.js';

// <appUrl>/book/<slug>/manage/<token>: the private link to see, cancel or move an online booking.
export const manageLink = (appUrl: string, slug: string, token: string) =>
  appLink(appUrl, `book/${slug}/manage/${token}`);
