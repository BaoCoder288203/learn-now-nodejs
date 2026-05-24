import { Response } from "express";
import { prisma } from "../db.js";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";

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
            questions: {
              orderBy: { questionNumber: "asc" },
              include: {
                options: {
                  orderBy: { letter: "asc" }
                }
              }
            }
          }
        }
      }
    });

    if (!test) {
      res.status(404).json({ error: "Test not found." });
      return;
    }

    res.json(test);
  } catch (error) {
    console.error("Get test details error:", error);
    res.status(500).json({ error: "Failed to load test structure." });
  }
}

// Start a test attempt
export async function startTestAttempt(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { testId } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const test = await prisma.test.findUnique({ where: { id: testId } });
    if (!test) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const attempt = await prisma.testAttempt.create({
      data: {
        userId,
        testId,
        status: "STARTED",
      }
    });

    res.status(201).json({ message: "Test started", attemptId: attempt.id });
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
        answers: {
          include: {
            question: {
              include: {
                testPart: true
              }
            }
          }
        }
      }
    });

    if (!attempt) {
      res.status(404).json({ error: "Attempt not found" });
      return;
    }

    if (attempt.status === "COMPLETED") {
      res.json(attempt);
      return;
    }

    // Dynamic Scoring Logic
    // Total questions answered
    let correctListening = 0;
    let totalListening = 0;
    let correctReading = 0;
    let totalReading = 0;

    attempt.answers.forEach((ans) => {
      const partNum = ans.question.testPart.partNumber;
      if (partNum >= 1 && partNum <= 4) {
        totalListening++;
        if (ans.isCorrect) correctListening++;
      } else if (partNum >= 5 && partNum <= 7) {
        totalReading++;
        if (ans.isCorrect) correctReading++;
      }
    });

    // Approximate TOEFL/TOEIC scoring model
    // 1-4 Listening (Max 100 Qs -> standard 495)
    // 5-7 Reading (Max 100 Qs -> standard 495)
    // For this context, standard simple direct scaling:
    // Listening score = (correctListening / Math.max(1, totalListening)) * 495
    // Reading score = (correctReading / Math.max(1, totalReading)) * 495
    const finalScore = Math.round(
      (totalListening > 0 ? (correctListening / totalListening) * 495 : 0) +
      (totalReading > 0 ? (correctReading / totalReading) * 495 : 0)
    );

    const completedAttempt = await prisma.testAttempt.update({
      where: { id: attemptId },
      data: {
        status: "COMPLETED",
        score: finalScore || 0,
        completedAt: new Date()
      },
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
        }
      }
    });

    res.json({ message: "Test finished", attempt: completedAttempt });
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
            description: true
          }
        }
      },
      orderBy: { startedAt: "desc" }
    });

    res.json(attempts);
  } catch (error) {
    console.error("getUserAttempts Error", error);
    res.status(500).json({ error: "Failed to load user attempts" });
  }
}
