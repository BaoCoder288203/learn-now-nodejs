-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "questionGroupId" TEXT;

-- AlterTable
ALTER TABLE "Test" ADD COLUMN     "examType" TEXT NOT NULL DEFAULT 'TOEIC';

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "extractedText" TEXT,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionGroup" (
    "id" TEXT NOT NULL,
    "testPartId" TEXT NOT NULL,
    "passage" TEXT,
    "transcript" TEXT,
    "audioUrl" TEXT,
    "imageUrl" TEXT,
    "groupOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuestionGroup_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionGroup" ADD CONSTRAINT "QuestionGroup_testPartId_fkey" FOREIGN KEY ("testPartId") REFERENCES "TestPart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_questionGroupId_fkey" FOREIGN KEY ("questionGroupId") REFERENCES "QuestionGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
