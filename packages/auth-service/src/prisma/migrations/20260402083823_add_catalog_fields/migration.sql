-- AlterTable
ALTER TABLE "providers" ADD COLUMN     "category" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "logo_url" TEXT,
ADD COLUMN     "source" TEXT DEFAULT 'manual';
