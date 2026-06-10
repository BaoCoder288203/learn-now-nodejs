-- AlterTable
ALTER TABLE "IngestionJob" ADD COLUMN "lastFailedStep" TEXT;

-- AlterTable
ALTER TABLE "IngestionDraft" ADD COLUMN "pipelineState" JSONB;
