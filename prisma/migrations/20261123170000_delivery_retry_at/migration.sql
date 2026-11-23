-- A FAILED delivery waits before its next try, so a short outage of a provider doesn't burn all of them
-- on three ticks in a row (review of #46).
ALTER TABLE "notification_deliveries" ADD COLUMN "retry_at" TIMESTAMPTZ(3);
