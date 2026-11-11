-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "role" "member_role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "note" TEXT,
    "staff_id" UUID,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_business_id_idx" ON "invitations"("business_id");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff"("business_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Not expressible in Prisma. Ownership is handed over, never given by an invitation.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_not_owner" CHECK ("role" <> 'OWNER');

-- One end: accepted or revoked, not both.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_one_end" CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL);
