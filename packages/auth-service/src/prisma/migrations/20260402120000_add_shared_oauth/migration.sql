-- CreateTable
CREATE TABLE "oauth_providers" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "callback_slug" TEXT NOT NULL,
    "authorize_url" TEXT NOT NULL,
    "token_url" TEXT NOT NULL,
    "client_id" TEXT,
    "client_secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_credentials" (
    "id" TEXT NOT NULL,
    "oauth_provider_id" TEXT NOT NULL,
    "external_account_id" TEXT,
    "account_email" TEXT,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_credentials_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "providers"
ADD COLUMN     "oauth_provider_key" TEXT;

-- AlterTable
ALTER TABLE "connections"
ADD COLUMN     "oauth_credential_id" TEXT,
ALTER COLUMN   "access_token" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "oauth_providers_key_key" ON "oauth_providers"("key");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_credentials_oauth_provider_id_external_account_id_key" ON "oauth_credentials"("oauth_provider_id", "external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "connections_provider_id_oauth_credential_id_key" ON "connections"("provider_id", "oauth_credential_id");

-- AddForeignKey
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_oauth_provider_id_fkey" FOREIGN KEY ("oauth_provider_id") REFERENCES "oauth_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_oauth_credential_id_fkey" FOREIGN KEY ("oauth_credential_id") REFERENCES "oauth_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
