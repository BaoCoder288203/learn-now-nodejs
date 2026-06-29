import { Response } from "express";
import { prisma } from "../db.js";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { getPresignedGetUrl, isS3Key } from "../services/s3Service.js";
import { computeToeicScore, getScopeQuestions } from "../services/toeicScoringService.js";
import {
  enrichSelectedWordsBatch,
  explainWrongAnswersBatch,
  type SelectedWordInput,
  type WrongAnswerInput,
} from "../services/testResultAiService.js";

async function runAttemptAiEnrichment(attemptId: string): Promise<void> {
  try {
    const [selectedWords, wrongAnswers] = await Promise.all([
      prisma.selectedWord.findMany({
        where: { testAttemptId: attemptId, aiStatus: { not: "done" } },
      }),
      prisma.answer.findMany({
        where: { testAttemptId: attemptId, isCorrect: false, aiExplanationStatus: { not: "done" } },
        include: {
          question: {
            include: { options: true, testPart: true },
          },
        },
      }),
    ]);

    if (selectedWords.length > 0) {
      const wordInputs: SelectedWordInput[] = selectedWords.map((w) => ({
        id: w.id,
        word: w.word,
        sentenceContext: w.sentenceContext,
        partNumber: w.partNumber,
      }));

      const enriched = await enrichSelectedWordsBatch(wordInputs);
      const now = new Date();

      for (const word of selectedWords) {
        const result = enriched.get(word.word.toLowerCase());
        if (result) {
          await prisma.selectedWord.update({
            where: { id: word.id },
            data: {
              meaningVi: result.meaningVi,
              example: result.example,
              synonyms: result.synonyms,
              aiStatus: "done",
              aiGeneratedAt: now,
            },
          });
        } else {
          await prisma.selectedWord.update({
            where: { id: word.id },
            data: { aiStatus: "failed" },
          });
        }
      }
    }

    if (wrongAnswers.length > 0) {
      const answerInputs: WrongAnswerInput[] = wrongAnswers.map((ans) => {
        const q = ans.question;
        const selectedOpt = q.options.find(
          (o) => o.letter.toUpperCase() === ans.selectedOption.toUpperCase()
        );
        const correctOpt = q.options.find(
          (o) => o.letter.toUpperCase() === q.correctAnswer.toUpperCase()
        );
        return {
          id: ans.id,
          partNumber: q.testPart.partNumber,
          questionText: q.questionText,
          passage: q.passage,
          transcript: q.transcript,
          selectedOption: ans.selectedOption,
          selectedOptionText: selectedOpt?.text || "",
          correctAnswer: q.correctAnswer,
          correctOptionText: correctOpt?.text || "",
          options: q.options.map((o) => ({ letter: o.letter, text: o.text })),
        };
      });

      const explained = await explainWrongAnswersBatch(answerInputs);
      const now = new Date();

      for (const ans of wrongAnswers) {
        const result = explained.get(ans.id);
        if (result) {
          await prisma.answer.update({
            where: { id: ans.id },
            data: {
              aiExplanation: result.explanationVi,
              aiExplanationStatus: "done",
              aiGeneratedAt: now,
            },
          });
        } else {
          await prisma.answer.update({
            where: { id: ans.id },
            data: { aiExplanationStatus: "failed" },
          });
        }
      }
    }
  } catch (err) {
    console.error("[runAttemptAiEnrichment] Error:", err);
  }
}

// Retrieve list of published tests
export async function getTests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const isUserAdmin = req.user?.role === "ADMIN";
    
    // Admins can see unpublished tests too
    const tests = await prisma.test.findMany({
      where: isUserAdmin ? {} : { published: true },
      include: {
        parts: {
          select: {
            id: true,
            partNumber: true,
            title: true,
            _count: { select: { questions: true } }
          }
        },
        _count: { select: { testAttempts: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    res.json(tests);
  } catch (error) {
    console.error("Get tests error:", error);
    res.status(500).json({ error: "Failed to retrieve tests." });
  }
}

// Retrieve single complete test structure with questions and options
export async function getTestDetails(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { testId } = req.params;

  try {
    const test = await prisma.test.findUnique({
      where: { id: testId },
      include: {
        parts: {
          orderBy: { partNumber: "asc" },
          include: {
            questionGroups: {
              orderBy: { groupOrder: "asc" },
              include: {
                images: {
                  orderBy: { order: "asc" },
                },
                questions: {
                  orderBy: { questionNumber: "asc" },
                  include: { options: { orderBy: { letter: "asc" } } },
                },
              },
            },
            questions: {
              orderBy: { questionNumber: "asc" },
              include: {
                options: { orderBy: { letter: "asc" } },
              },
            },
          },
        },
      },
    });

    if (!test) {
      res.status(404).json({ error: "Test not found." });
      return;
    }

    const partsWithSignedAssets = await Promise.all(
      test.parts.map(async (part) => {
        const audioUrl =
          part.audioUrl && isS3Key(part.audioUrl)
            ? await getPresignedGetUrl(part.audioUrl, 7200)
            : part.audioUrl;

        const questionGroups = await Promise.all(
          (part.questionGroups || []).map(async (group) => {
            const images = await Promise.all(
              (group.images || []).map(async (image) => ({
                ...image,
                imageUrl:
                  image.imageUrl && isS3Key(image.imageUrl)
                    ? await getPresignedGetUrl(image.imageUrl, 7200)
                    : image.imageUrl,
              }))
            );

            return {
              ...group,
              imageUrl:
                group.imageUrl && isS3Key(group.imageUrl)
                  ? await getPresignedGetUrl(group.imageUrl, 7200)
                  : group.imageUrl,
              images,
              questions: await Promise.all(
                group.questions.map(async (question) => ({
                  ...question,
                  image:
                    question.image && isS3Key(question.image)
                      ? await getPresignedGetUrl(question.image, 7200)
                      : question.image,
                }))
              ),
            };
          })
        );

        const questions = await Promise.all(
          (part.questions || []).map(async (question) => ({
            ...question,
            image:
              question.image && isS3Key(question.image)
                ? await getPresignedGetUrl(question.image, 7200)
                : question.image,
          }))
        );

        return { ...part, audioUrl, questionGroups, questions };
      })
    );

    res.json({ ...test, parts: partsWithSignedAssets });
  } catch (error) {
    console.error("Get test details error:", error);
    res.status(500).json({ error: "Failed to load test structure." });
  }
}

// Start a test attempt
export async function startTestAttempt(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { testId, partNumber } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const scopePartNumber =
    partNumber != null && partNumber !== ""
      ? Number(partNumber)
      : null;

  if (scopePartNumber != null && (scopePartNumber < 1 || scopePartNumber > 7 || Number.isNaN(scopePartNumber))) {
    res.status(400).json({ error: "partNumber must be between 1 and 7." });
    return;
  }

  try {
    const test = await prisma.test.findUnique({ where: { id: testId } });
    if (!test) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    let resumed = false;
    const attempt = await prisma.$transaction(async (tx) => {
      const startedAttempts = await tx.testAttempt.findMany({
        where: { userId, testId, status: "STARTED" },
        orderBy: { startedAt: "desc" },
      });

      if (startedAttempts.length > 0) {
        resumed = true;
        const primary = startedAttempts[0]!;
        if (startedAttempts.length > 1) {
          const duplicateIds = startedAttempts.slice(1).map((a) => a.id);
          await tx.testAttempt.deleteMany({ where: { id: { in: duplicateIds } } });
        }
        return primary;
      }

      return tx.testAttempt.create({
        data: {
          userId,
          testId,
          status: "STARTED",
          scopePartNumber,
        },
      });
    });

    if (resumed) {
      res.json({ message: "Resuming existing attempt", attemptId: attempt.id });
    } else {
      res.status(201).json({ message: "Test started", attemptId: attempt.id });
    }
  } catch (error) {
    console.error("Start test attempt error:", error);
    res.status(500).json({ error: "Failed to initiate test attempt." });
  }
}

// Submit single answer during a test (or can submit all in a batch at the end)
export async function submitAnswer(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { attemptId, questionId, selectedOption } = req.body;

  try {
    const attempt = await prisma.testAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.status === "COMPLETED") {
      res.status(400).json({ error: "Invalid or already completed test attempt." });
      return;
    }

    const question = await prisma.question.findUnique({ where: { id: questionId } });
    if (!question) {
      res.status(404).json({ error: "Question not found." });
      return;
    }

    const isCorrect = question.correctAnswer.toUpperCase() === selectedOption.toUpperCase();

    // Upsert answer for this question and attempt
    const existingAnswer = await prisma.answer.findFirst({
      where: { testAttemptId: attemptId, questionId }
    });

    let savedAnswer;
    if (existingAnswer) {
      savedAnswer = await prisma.answer.update({
        where: { id: existingAnswer.id },
        data: { selectedOption, isCorrect }
      });
    } else {
      savedAnswer = await prisma.answer.create({
        data: {
          testAttemptId: attemptId,
          questionId,
          selectedOption,
          isCorrect
        }
      });
    }

    res.json({ message: "Answer saved", answer: savedAnswer });
  } catch (error) {
    console.error("Submit answer error:", error);
    res.status(500).json({ error: "Failed to save answer" });
  }
}

// Visual highlighting/tagging of a word DURING the test (Part 5 - 7 only)
export async function selectWordInTest(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { attemptId, questionId, word, sentenceContext, partNumber } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!partNumber || partNumber < 5) {
    res.status(400).json({ error: "Word selection is only permitted in Reading Parts 5–7." });
    return;
  }

  try {
    // Save to selected words
    const selection = await prisma.selectedWord.create({
      data: {
        userId,
        testAttemptId: attemptId,
        questionId,
        word: word.trim(),
        sentenceContext: sentenceContext || "",
        partNumber
      }
    });

    res.json({ message: "Word marked/selected inside reading view.", selection });
  } catch (error) {
    console.error("Select word error:", error);
    res.status(500).json({ error: "Failed to tag word" });
  }
}

// Complete test attempt and compute final scores
export async function finishTestAttempt(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { attemptId } = req.body;

  try {
    const attempt = await prisma.testAttempt.findUnique({
      where: { id: attemptId },
      include: {
        answers: true,
      },
    });

    if (!attempt) {
      res.status(404).json({ error: "Attempt not found" });
      return;
    }

    if (attempt.status === "COMPLETED") {
      const completed = await prisma.testAttempt.findUnique({
        where: { id: attemptId },
        include: {
          answers: {
            include: {
              question: {
                include: { options: true, testPart: true },
              },
            },
          },
        },
      });
      res.json({ attempt: completed });
      return;
    }

    const scopeQuestions = await getScopeQuestions(attempt.testId, attempt.scopePartNumber);
    const scoreResult = computeToeicScore(
      scopeQuestions,
      attempt.answers.map((a) => ({ questionId: a.questionId, isCorrect: a.isCorrect })),
      attempt.scopePartNumber
    );

    const completedAttempt = await prisma.$transaction(async (tx) => {
      const completed = await tx.testAttempt.update({
        where: { id: attemptId },
        data: {
          status: "COMPLETED",
          score: scoreResult.totalScore,
          listeningScore: scoreResult.listeningScore,
          readingScore: scoreResult.readingScore,
          completedAt: new Date(),
        },
        include: {
          answers: {
            include: {
              question: {
                include: {
                  options: true,
                  testPart: true,
                },
              },
            },
          },
        },
      });

      await tx.testAttempt.deleteMany({
        where: {
          userId: attempt.userId,
          testId: attempt.testId,
          status: "STARTED",
          id: { not: attemptId },
        },
      });

      return completed;
    });

    res.json({ message: "Test finished", attempt: completedAttempt });

    void runAttemptAiEnrichment(attemptId);
  } catch (error) {
    console.error("Finish test error:", error);
    res.status(500).json({ error: "Failed to finalize test attempt." });
  }
}

// Get selected words for a specific attempt
export async function getSelectedWordsByAttempt(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { attemptId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const words = await prisma.selectedWord.findMany({
      where: { testAttemptId: attemptId, userId },
      include: {
        question: {
          select: {
            questionNumber: true,
            questionText: true
          }
        }
      }
    });

    res.json(words);
  } catch (error) {
    console.error("Get selected words error:", error);
    res.status(500).json({ error: "Failed to load selected words" });
  }
}

// Get a single completed attempt with full answers (for result page)
export async function getAttemptResult(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { attemptId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const attempt = await prisma.testAttempt.findUnique({
      where: { id: attemptId },
      include: {
        answers: {
          include: {
            question: {
              include: {
                options: true,
                testPart: true
              }
            }
          }
        },
        test: { select: { title: true, description: true } }
      }
    });

    if (!attempt) {
      res.status(404).json({ error: "Không tìm thấy phiên thi." });
      return;
    }

    if (attempt.userId !== userId) {
      res.status(403).json({ error: "Bạn không có quyền xem kết quả này." });
      return;
    }

    const scopeQuestions = await getScopeQuestions(attempt.testId, attempt.scopePartNumber);
    const scoreBreakdown = computeToeicScore(
      scopeQuestions,
      attempt.answers.map((a) => ({ questionId: a.questionId, isCorrect: a.isCorrect })),
      attempt.scopePartNumber
    );

    res.json({ attempt, scoreBreakdown });
  } catch (error) {
    console.error("Get attempt result error:", error);
    res.status(500).json({ error: "Không thể tải kết quả bài thi." });
  }
}

// Get historic attempts for the user
export async function getUserAttempts(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const attempts = await prisma.testAttempt.findMany({
      where: { userId },
      include: {
        test: {
          select: {
            title: true,
            description: true,
          },
        },
        _count: { select: { answers: true } },
      },
      orderBy: { startedAt: "desc" },
    });

    const testsWithCompleted = new Set(
      attempts.filter((a) => a.status === "COMPLETED").map((a) => a.testId)
    );

    const latestStartedByTest = new Map<string, string>();
    for (const att of attempts) {
      if (att.status === "STARTED" && !latestStartedByTest.has(att.testId)) {
        latestStartedByTest.set(att.testId, att.id);
      }
    }

    const filtered = attempts.filter((att) => {
      if (att.status !== "STARTED") return true;

      if (latestStartedByTest.get(att.testId) !== att.id) return false;

      if (testsWithCompleted.has(att.testId) && att._count.answers === 0) {
        return false;
      }

      return true;
    });

    res.json(
      filtered.map(({ _count, ...att }) => att)
    );
  } catch (error) {
    console.error("getUserAttempts Error", error);
    res.status(500).json({ error: "Failed to load user attempts" });
  }
}
