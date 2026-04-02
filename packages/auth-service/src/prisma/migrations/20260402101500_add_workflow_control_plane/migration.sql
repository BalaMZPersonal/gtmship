-- CreateTable
CREATE TABLE "workflow_deployments" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "workflow_version" TEXT,
    "provider" TEXT NOT NULL,
    "region" TEXT,
    "gcp_project" TEXT,
    "execution_kind" TEXT NOT NULL,
    "auth_mode" TEXT NOT NULL DEFAULT 'proxy',
    "trigger_type" TEXT,
    "trigger_config" JSONB,
    "resource_inventory" JSONB,
    "endpoint_url" TEXT,
    "scheduler_id" TEXT,
    "event_trigger_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deployed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_bindings" (
    "id" TEXT NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "provider_slug" TEXT NOT NULL,
    "selector_type" TEXT NOT NULL DEFAULT 'latest_active',
    "selector_value" TEXT,
    "connection_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "execution_id" TEXT,
    "trigger_source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "cloud_ref" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "request_payload" JSONB,
    "response_payload" JSONB,
    "error" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_deployments_workflow_id_idx" ON "workflow_deployments"("workflow_id");

-- CreateIndex
CREATE INDEX "workflow_deployments_provider_idx" ON "workflow_deployments"("provider");

-- CreateIndex
CREATE INDEX "workflow_deployments_status_idx" ON "workflow_deployments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_bindings_deployment_id_provider_slug_key" ON "workflow_bindings"("deployment_id", "provider_slug");

-- CreateIndex
CREATE INDEX "workflow_bindings_provider_slug_idx" ON "workflow_bindings"("provider_slug");

-- CreateIndex
CREATE INDEX "workflow_bindings_connection_id_idx" ON "workflow_bindings"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_execution_id_key" ON "workflow_runs"("execution_id");

-- CreateIndex
CREATE INDEX "workflow_runs_deployment_id_created_at_idx" ON "workflow_runs"("deployment_id", "created_at");

-- CreateIndex
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs"("status");

-- AddForeignKey
ALTER TABLE "workflow_bindings" ADD CONSTRAINT "workflow_bindings_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "workflow_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_bindings" ADD CONSTRAINT "workflow_bindings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "workflow_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
