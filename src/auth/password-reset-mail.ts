import type { Locale } from '../account/locale.js';
import { appLink } from '../common/app-link.js';

// <appUrl>/reset-password/<token>
export const passwordResetLink = (appUrl: string, token: string) => appLink(appUrl, `reset-password/${token}`);

const LETTERS: Record<Locale, (link: string) => { subject: string; text: string }> = {
  en: (link) => ({
    subject: 'Reset your BookedUp password',
    text: `Someone (hopefully you) asked to reset the password of your BookedUp account. The link works for one hour: ${link}\n\nIf it wasn't you, ignore this letter: your password stays.`,
  }),
  ru: (link) => ({
    subject: 'Сброс пароля BookedUp',
    text: `Кто-то (надеемся, вы) попросил сбросить пароль вашего аккаунта BookedUp. Ссылка действует один час: ${link}\n\nЕсли это были не вы, просто проигнорируйте письмо: пароль останется прежним.`,
  }),
};

export const passwordResetMail = (locale: Locale, link: string) => LETTERS[locale](link);
