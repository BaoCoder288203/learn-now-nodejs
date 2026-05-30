-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('QUEUED', 'EXTRACTING', 'CLASSIFYING', 'REVIEW_REQUIRED', 'IMPORTING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "IngestionFileRole" AS ENUM ('EXAM_DOC', 'LISTENING_KEY_DOC', 'READING_KEY_IMAGE', 'AUDIO_FILE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "IngestionJob" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "IngestionStatus" NOT NULL DEFAULT 'QUEUED',
    "progressStep" TEXT,
    "confidence" DOUBLE PRECISION,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "resultSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionFile" (
    "id" TEXT NOT NULL,
    "ingestionJobId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "detectedRole" "IngestionFileRole" NOT NULL DEFAULT 'UNKNOWN',
    "confidence" DOUBLE PRECISION,
    "extractionSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestionFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionDraft" (
    "id" TEXT NOT NULL,
    "ingestionJobId" TEXT NOT NULL,
    "canonicalJson" JSONB NOT NULL,
    "classificationJson" JSONB,
    "parsedToeicJson" JSONB,
    "reviewPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IngestionDraft_ingestionJobId_key" ON "IngestionDraft"("ingestionJobId");

-- AddForeignKey
ALTER TABLE "IngestionJob" ADD CONSTRAINT "IngestionJob_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionJob" ADD CONSTRAINT "IngestionJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionFile" ADD CONSTRAINT "IngestionFile_ingestionJobId_fkey" FOREIGN KEY ("ingestionJobId") REFERENCES "IngestionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionDraft" ADD CONSTRAINT "IngestionDraft_ingestionJobId_fkey" FOREIGN KEY ("ingestionJobId") REFERENCES "IngestionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
