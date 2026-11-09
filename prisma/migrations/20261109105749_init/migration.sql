-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "member_role" AS ENUM ('OWNER', 'ADMIN', 'MASTER');

-- CreateTable
CREATE TABLE "businesses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "time_zone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_logins" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_logins_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "member_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_slug_key" ON "businesses"("slug");

-- CreateIndex
CREATE INDEX "locations_business_id_idx" ON "locations"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_business_id_idx" ON "memberships"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_business_id_key" ON "memberships"("user_id", "business_id");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_logins" ADD CONSTRAINT "password_logins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Not expressible in schema.prisma (CHECK constraints). Emails are stored lowercased, so the unique index
-- above is case-insensitive. Normalise at the API boundary; this keeps a missed spot out.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));

-- The slug is the public booking address (/book/<slug>) people type by hand: lowercase
-- latin letters and digits, single hyphens between. Lowercase-only also makes the
-- unique index case-insensitive, like the email's.
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- Exactly one owner per business.
-- At most one: a partial unique index.
CREATE UNIQUE INDEX "memberships_one_owner" ON "memberships"("business_id") WHERE "role" = 'OWNER';

-- At least one: checked at commit (deferred), so a business and its owner are created in
-- one transaction, ownership is handed over by demoting then promoting, and deleting a
-- whole business (which cascades to its memberships) passes — the business is gone by
-- then. Deleting the owner's account, or demoting them, while the business exists fails.
CREATE FUNCTION "business_has_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
BEGIN
  -- Separate branches, not one CASE: PL/pgSQL resolves every field a CASE names, and a
  -- businesses row has no business_id.
  IF TG_TABLE_NAME = 'businesses' THEN
    target := NEW."id";
  ELSE
    target := OLD."business_id";
  END IF;

  IF EXISTS (SELECT 1 FROM "businesses" WHERE "id" = target)
     AND NOT EXISTS (SELECT 1 FROM "memberships" WHERE "business_id" = target AND "role" = 'OWNER') THEN
    RAISE EXCEPTION 'business % has no owner', target
      USING ERRCODE = 'check_violation', CONSTRAINT = 'businesses_has_owner';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "businesses_has_owner"
  AFTER INSERT ON "businesses"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "business_has_owner"();

CREATE CONSTRAINT TRIGGER "memberships_keep_owner"
  AFTER UPDATE OR DELETE ON "memberships"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "business_has_owner"();
