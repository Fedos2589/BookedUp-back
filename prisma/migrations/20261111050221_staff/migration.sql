-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "user_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_business_id_id_key" ON "staff"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_user_id_business_id_key" ON "staff"("user_id", "business_id");

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_business_id_fkey" FOREIGN KEY ("user_id", "business_id") REFERENCES "memberships"("user_id", "business_id") ON DELETE NO ACTION ON UPDATE CASCADE;
