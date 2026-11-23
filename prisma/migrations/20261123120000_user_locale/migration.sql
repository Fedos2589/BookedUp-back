-- The interface language of the account. A CHECK, not a Postgres enum: the list grows with the
-- front's texts (src/account/locale.ts), and Prisma would then see a new enum value as drift.
ALTER TABLE "users" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "users" ADD CONSTRAINT "users_locale_known" CHECK ("locale" IN ('en', 'ru'));
