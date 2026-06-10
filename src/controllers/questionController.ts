import type { Request, Response } from "express";
import { prisma } from "../db.js";

export async function getQuestionAnalysis(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: "Missing question id" });
    return;
  }

  const question = await prisma.question.findUnique({
    where: { id },
    select: {
      id: true,
      questionNumber: true,
      correctAnswer: true,
      analysis: true,
      vocabularyItems: {
        select: {
          word: true,
          meaning: true,
          ipa: true,
          example: true,
          level: true,
        },
      },
    },
  });

  if (!question) {
    res.status(404).json({ error: "Question not found" });
    return;
  }

  if (!question.analysis || question.analysis.status !== "done") {
    res.status(200).json({
      questionId: question.id,
      questionNumber: question.questionNumber,
      correctAnswer: question.correctAnswer,
      status: question.analysis?.status ?? "pending",
      explanation: null,
      grammar: null,
      translation: null,
      difficulty: null,
      vocabulary: question.vocabularyItems,
    });
    return;
  }

  res.json({
    questionId: question.id,
    questionNumber: question.questionNumber,
    correctAnswer: question.correctAnswer,
    status: question.analysis.status,
    explanation: question.analysis.explanation,
    grammar: question.analysis.grammar,
    translation: question.analysis.translation,
    difficulty: question.analysis.difficulty,
    vocabulary: question.vocabularyItems,
  });
}

/** Phase 2.1 placeholder — enqueue GPT content generation for a test. */
export async function enqueueTestContentGeneration(req: Request, res: Response): Promise<void> {
  const { testId } = req.params;
  if (!testId) {
    res.status(400).json({ error: "Missing testId" });
    return;
  }

  const test = await prisma.test.findUnique({ where: { id: testId }, select: { id: true } });
  if (!test) {
    res.status(404).json({ error: "Test not found" });
    return;
  }

  res.status(202).json({
    message: "Content generation not implemented yet (Phase 2.1). Schema is ready.",
    testId,
    status: "pending",
  });
}
