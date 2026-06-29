-- AlterTable
ALTER TABLE "TestAttempt" ADD COLUMN "listeningScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TestAttempt" ADD COLUMN "readingScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TestAttempt" ADD COLUMN "scopePartNumber" INTEGER;

-- AlterTable
ALTER TABLE "Answer" ADD COLUMN "aiExplanation" TEXT;
ALTER TABLE "Answer" ADD COLUMN "aiExplanationStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "Answer" ADD COLUMN "aiGeneratedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SelectedWord" ADD COLUMN "meaningVi" TEXT;
ALTER TABLE "SelectedWord" ADD COLUMN "example" TEXT;
ALTER TABLE "SelectedWord" ADD COLUMN "synonyms" JSONB;
ALTER TABLE "SelectedWord" ADD COLUMN "aiStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "SelectedWord" ADD COLUMN "aiGeneratedAt" TIMESTAMP(3);
