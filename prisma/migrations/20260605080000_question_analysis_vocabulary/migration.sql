-- CreateTable
CREATE TABLE "QuestionAnalysis" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "explanation" TEXT,
    "grammar" TEXT,
    "translation" TEXT,
    "difficulty" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionVocabulary" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "meaning" TEXT,
    "ipa" TEXT,
    "example" TEXT,
    "level" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionVocabulary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuestionAnalysis_questionId_key" ON "QuestionAnalysis"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionVocabulary_questionId_word_key" ON "QuestionVocabulary"("questionId", "word");

-- AddForeignKey
ALTER TABLE "QuestionAnalysis" ADD CONSTRAINT "QuestionAnalysis_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionVocabulary" ADD CONSTRAINT "QuestionVocabulary_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
