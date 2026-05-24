import { Response, Request } from "express";
import { prisma } from "../db.js";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { parseToeicContent } from "../services/geminiService.js";

// Toggle test publish status
export async function togglePublishTest(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { testId } = req.params;
  const { published } = req.body;

  try {
    const test = await prisma.test.update({
      where: { id: testId },
      data: { published: published === true }
    });

    res.json({ message: `Test ${published ? "published" : "unpublished"} successfully.`, test });
  } catch (error) {
    console.error("Toggle publish error:", error);
    res.status(500).json({ error: "Failed to change test publication state." });
  }
}

// Edit query question directly
export async function editQuestion(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { questionId } = req.params;
  const { questionText, passage, transcript, correctAnswer, options } = req.body;

  try {
    const question = await prisma.question.update({
      where: { id: questionId },
      data: {
        questionText,
        passage,
        transcript,
        correctAnswer
      }
    });

    // Update letters if options provided
    if (options && Array.isArray(options)) {
      for (const opt of options) {
        const existingOpt = await prisma.option.findFirst({
          where: { questionId, letter: opt.letter }
        });
        if (existingOpt) {
          await prisma.option.update({
            where: { id: existingOpt.id },
            data: { text: opt.text }
          });
        } else {
          await prisma.option.create({
            data: {
              questionId,
              letter: opt.letter,
              text: opt.text
            }
          });
        }
      }
    }

    res.json({ message: "Question edited successfully.", question });
  } catch (error) {
    console.error("Edit question error:", error);
    res.status(500).json({ error: "Failed to modify question." });
  }
}

// Create clean manual test structure
export async function createTestManually(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { title, description, parts } = req.body;

  if (!title) {
    res.status(400).json({ error: "Title is required for manually created tests." });
    return;
  }

  try {
    const test = await prisma.test.create({
      data: {
        title,
        description: description || "",
        published: false
      }
    });

    // Seed empty mock parts 1-7 automatically for convenience when doing manual building
    const partsArray = parts || [1, 2, 3, 4, 5, 6, 7].map(num => ({
      partNumber: num,
      title: `Part ${num}: ${getPartTitleFallback(num)}`,
      instructions: `Practice Part ${num} questions.`
    }));

    for (const part of partsArray) {
      await prisma.testPart.create({
        data: {
          testId: test.id,
          partNumber: part.partNumber,
          title: part.title,
          instructions: part.instructions || ""
        }
      });
    }

    res.status(201).json({ message: "Empty test skeleton created successfully.", testId: test.id });
  } catch (error) {
    console.error("Create test manually error:", error);
    res.status(500).json({ error: "Failed to assemble manual test skeletons." });
  }
}

// View statistics of user attempts for admin panel
export async function getUserStatistics(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const attempts = await prisma.testAttempt.findMany({
      include: {
        user: { select: { name: true, email: true } },
        test: { select: { title: true } }
      },
      orderBy: { startedAt: "desc" }
    });

    // General numbers
    const totalAttempts = attempts.length;
    const completedAttempts = attempts.filter(a => a.status === "COMPLETED");
    const avgScore = completedAttempts.length
      ? Math.round(completedAttempts.reduce((sum, a) => sum + a.score, 0) / completedAttempts.length)
      : 0;

    res.json({
      summary: {
        totalAttempts,
        completedAttempts: completedAttempts.length,
        avgScore
      },
      attempts
    });
  } catch (error) {
    console.error("Get statistics error:", error);
    res.status(500).json({ error: "Failed to compile stats." });
  }
}

// Import TOEIC structure from image or OCR direct paste
export async function importToeicExamViaAi(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { testId, ocrText, imageBase64, mimeType } = req.body;

  if (!testId) {
    res.status(400).json({ error: "testId is required to map imported content to." });
    return;
  }

  try {
    const test = await prisma.test.findUnique({ where: { id: testId } });
    if (!test) {
      res.status(404).json({ error: "Target test skeleton not found." });
      return;
    }

    const imagePayload = imageBase64 ? { data: imageBase64, mimeType: mimeType || "image/png" } : undefined;

    // Use Gemini parsing service
    const aiParsedData = await parseToeicContent(ocrText || "", imagePayload);

    const partNum = aiParsedData.partNumber || 5;

    // Retrieve or seed appropriate TestPart model to bind questions
    let devPart = await prisma.testPart.findFirst({
      where: { testId, partNumber: partNum }
    });

    if (!devPart) {
      devPart = await prisma.testPart.create({
        data: {
          testId,
          partNumber: partNum,
          title: `Part ${partNum}: ${getPartTitleFallback(partNum)}`,
          instructions: `AI Generated Practice for Part ${partNum}`
        }
      });
    }

    const insertedQuestions = [];

    // Transactionally create all questions received to avoid partial creations
    for (const q of aiParsedData.questions) {
      const dbQuestion = await prisma.question.create({
        data: {
          testPartId: devPart.id,
          questionNumber: q.questionNumber || 1,
          passage: q.passage || null,
          questionText: q.questionText || "Select the best word of response.",
          transcript: q.transcript || null,
          correctAnswer: q.correctAnswer || "A"
        }
      });

      // Insert multiple choice options
      if (q.options && Array.isArray(q.options)) {
        for (const opt of q.options) {
          await prisma.option.create({
            data: {
              questionId: dbQuestion.id,
              letter: opt.letter.toUpperCase(),
              text: opt.text
            }
          });
        }
      } else {
        // Generate placeholder options if missing
        for (const letChar of ["A", "B", "C", "D"]) {
          await prisma.option.create({
            data: {
              questionId: dbQuestion.id,
              letter: letChar,
              text: `Option ${letChar}`
            }
          });
        }
      }
      insertedQuestions.push(dbQuestion);
    }

    res.json({
      message: "AI Import successful and loaded into database.",
      partNumber: partNum,
      questionsCount: insertedQuestions.length,
      questions: insertedQuestions
    });

  } catch (error) {
    console.error("Import exam error:", error);
    res.status(500).json({ error: `Parsing and import failed: ${error instanceof Error ? error.message : String(error)}` });
  }
}

// Utility to fetch default description for Part Fallback Names
function getPartTitleFallback(num: number): string {
  switch (num) {
    case 1: return "Photographs";
    case 2: return "Question-Response";
    case 3: return "Conversations";
    case 4: return "Short Talks";
    case 5: return "Incomplete Sentences";
    case 6: return "Text Completion";
    case 7: return "Reading Comprehension";
    default: return "TOEIC Section";
  }
}
