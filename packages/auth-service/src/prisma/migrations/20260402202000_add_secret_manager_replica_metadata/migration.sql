-- AlterTable
ALTER TABLE "workflow_deployments"
ADD COLUMN "auth_backend_kind" TEXT,
ADD COLUMN "auth_backend_region" TEXT,
ADD COLUMN "auth_backend_project_id" TEXT,
ADD COLUMN "auth_runtime_access" TEXT,
ADD COLUMN "runtime_auth_manifest" JSONB;

-- CreateTable
CREATE TABLE "connection_secret_replicas" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "backend_kind" TEXT NOT NULL,
    "backend_region" TEXT NOT NULL DEFAULT '',
    "backend_project_id" TEXT NOT NULL DEFAULT '',
    "runtime_secret_ref" TEXT NOT NULL,
    "control_secret_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_synced_at" TIMESTAMP(3),
    "last_error" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connection_secret_replicas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connection_secret_replicas_connection_backend_target_key"
ON "connection_secret_replicas"("connection_id", "backend_kind", "backend_region", "backend_project_id");

-- CreateIndex
CREATE INDEX "connection_secret_replicas_backend_kind_idx"
ON "connection_secret_replicas"("backend_kind");

-- CreateIndex
CREATE INDEX "connection_secret_replicas_status_idx"
ON "connection_secret_replicas"("status");

-- AddForeignKey
ALTER TABLE "connection_secret_replicas"
ADD CONSTRAINT "connection_secret_replicas_connection_id_fkey"
FOREIGN KEY ("connection_id") REFERENCES "connections"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
