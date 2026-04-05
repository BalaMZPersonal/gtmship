-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "scope" TEXT NOT NULL DEFAULT 'app',
    "workflow_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'agent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memories_scope_idx" ON "memories"("scope");

-- CreateIndex
CREATE INDEX "memories_workflow_id_idx" ON "memories"("workflow_id");

-- CreateIndex
CREATE INDEX "memories_category_idx" ON "memories"("category");
