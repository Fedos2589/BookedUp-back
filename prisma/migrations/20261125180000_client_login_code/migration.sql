-- A sign-in carries a four-digit code: the page shows it and the bot repeats it, so a person can spot a
-- forwarded link (the code on the page is not the one in the bot). It is not a secret and the server never
-- checks it. Logins live ten minutes; the ones that exist now cannot be given a code.
DELETE FROM "client_logins";
ALTER TABLE "client_logins" ADD COLUMN "code" TEXT NOT NULL;
ALTER TABLE "client_logins" ADD CONSTRAINT "client_logins_code" CHECK ("code" ~ '^[0-9]{4}$');
