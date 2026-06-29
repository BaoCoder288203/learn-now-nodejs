import { prisma } from "../db.js";

export interface ToeicScoreResult {
  listeningScore: number;
  readingScore: number;
  totalScore: number;
  listeningCorrect: number;
  listeningTotal: number;
  readingCorrect: number;
  readingTotal: number;
  isPartPractice: boolean;
  scopePartNumber: number | null;
}

interface ScopeQuestion {
  id: string;
  partNumber: number;
}

/**
 * Load all questions in the attempt scope (full test or single Part practice).
 */
export async function getScopeQuestions(
  testId: string,
  scopePartNumber: number | null
): Promise<ScopeQuestion[]> {
  const parts = await prisma.testPart.findMany({
    where: {
      testId,
      ...(scopePartNumber != null ? { partNumber: scopePartNumber } : {}),
    },
    include: {
      questions: { select: { id: true } },
      questionGroups: {
        include: {
          questions: { select: { id: true } },
        },
      },
    },
  });

  const result: ScopeQuestion[] = [];
  for (const part of parts) {
    const questionIds = new Set<string>();
    for (const q of part.questions) questionIds.add(q.id);
    for (const group of part.questionGroups) {
      for (const q of group.questions) questionIds.add(q.id);
    }
    for (const id of questionIds) {
      result.push({ id, partNumber: part.partNumber });
    }
  }

  return result;
}

/**
 * Compute TOEIC scores using total questions in scope as denominator.
 * Unanswered questions count as incorrect.
 */
export function computeToeicScore(
  scopeQuestions: ScopeQuestion[],
  answers: Array<{ questionId: string; isCorrect: boolean }>,
  scopePartNumber: number | null
): ToeicScoreResult {
  const answerMap = new Map(answers.map((a) => [a.questionId, a.isCorrect]));

  let listeningCorrect = 0;
  let listeningTotal = 0;
  let readingCorrect = 0;
  let readingTotal = 0;

  for (const q of scopeQuestions) {
    const isListening = q.partNumber >= 1 && q.partNumber <= 4;
    const isReading = q.partNumber >= 5 && q.partNumber <= 7;
    const correct = answerMap.get(q.id) === true;

    if (isListening) {
      listeningTotal++;
      if (correct) listeningCorrect++;
    } else if (isReading) {
      readingTotal++;
      if (correct) readingCorrect++;
    }
  }

  const isPartPractice = scopePartNumber != null;

  let listeningScore = 0;
  let readingScore = 0;

  if (isPartPractice) {
    const partNum = scopePartNumber!;
    const isListeningPart = partNum >= 1 && partNum <= 4;
    const maxSkillScore = 495;

    if (isListeningPart && listeningTotal > 0) {
      listeningScore = Math.round((listeningCorrect / listeningTotal) * maxSkillScore);
    } else if (!isListeningPart && readingTotal > 0) {
      readingScore = Math.round((readingCorrect / readingTotal) * maxSkillScore);
    }
  } else {
    if (listeningTotal > 0) {
      listeningScore = Math.round((listeningCorrect / listeningTotal) * 495);
    }
    if (readingTotal > 0) {
      readingScore = Math.round((readingCorrect / readingTotal) * 495);
    }
  }

  return {
    listeningScore,
    readingScore,
    totalScore: listeningScore + readingScore,
    listeningCorrect,
    listeningTotal,
    readingCorrect,
    readingTotal,
    isPartPractice,
    scopePartNumber,
  };
}
