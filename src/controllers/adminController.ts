import { Response } from "express";
import path from "path";
import { prisma } from "../db.js";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { parseToeicContent } from "../services/toeicAiService.js";
import {
  processToeicExamResumable,
  type UploadedFileRef,
} from "../services/examProcessingService.js";
import {
  findLastFailedStep,
  parsePipelineState,
  pipelineStepsSummary,
} from "../services/importPipelineState.js";
import {
  ensurePipelineState,
  loadPipelineStateForJob,
  markJobFailed,
} from "../services/importPipelinePersistence.js";
import { buildIntakeObjectKey, buildObjectKey, type ExamFileType } from "../services/s3ObjectKey.js";
import { uploadObject } from "../services/s3Service.js";
import {
  importAfterReview,
  resumeImportJob,
  runDocumentIngestionJob,
  type UploadedBatchFile,
} from "../services/documentIngestionService.js";
import { IngestionStatus } from "@prisma/client";

// Toggle test publish status
export async function togglePublishTest(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { testId } = req.params;
  const { published } = req.body;

  try {
    const test = await prisma.test.update({
      where: { id: testId },
      data: { published: published === true },
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
      data: { questionText, passage, transcript, correctAnswer },
    });

    if (options && Array.isArray(options)) {
      for (const opt of options) {
        const existingOpt = await prisma.option.findFirst({
          where: { questionId, letter: opt.letter },
        });
        if (existingOpt) {
          await prisma.option.update({
            where: { id: existingOpt.id },
            data: { text: opt.text },
          });
        } else {
          await prisma.option.create({
            data: { questionId, letter: opt.letter, text: opt.text },
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
  const { title, description, examType, parts } = req.body;

  if (!title) {
    res.status(400).json({ error: "Title is required for manually created tests." });
    return;
  }

  try {
    const test = await prisma.test.create({
      data: {
        title,
        description: description || "",
        examType: examType || "TOEIC",
        published: false,
      },
    });

    const partsArray =
      parts ||
      [1, 2, 3, 4, 5, 6, 7].map((num) => ({
        partNumber: num,
        title: `Part ${num}: ${getPartTitleFallback(num)}`,
        instructions: `Luyện tập Part ${num}.`,
      }));

    for (const part of partsArray) {
      await prisma.testPart.create({
        data: {
          testId: test.id,
          partNumber: part.partNumber,
          title: part.title,
          instructions: part.instructions || "",
        },
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
        test: { select: { title: true } },
      },
      orderBy: { startedAt: "desc" },
    });

    const totalAttempts = attempts.length;
    const completedAttempts = attempts.filter((a) => a.status === "COMPLETED");
    const avgScore = completedAttempts.length
      ? Math.round(completedAttempts.reduce((sum, a) => sum + a.score, 0) / completedAttempts.length)
      : 0;

    res.json({
      summary: { totalAttempts, completedAttempts: completedAttempts.length, avgScore },
      attempts,
    });
  } catch (error) {
    console.error("Get statistics error:", error);
    res.status(500).json({ error: "Failed to compile stats." });
  }
}

// Legacy: Import TOEIC structure from image or OCR direct paste
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
    const aiParsedData = await parseToeicContent(ocrText || "", imagePayload);
    const partNum = aiParsedData.partNumber || 5;

    let devPart = await prisma.testPart.findFirst({
      where: { testId, partNumber: partNum },
    });

    if (!devPart) {
      devPart = await prisma.testPart.create({
        data: {
          testId,
          partNumber: partNum,
          title: `Part ${partNum}: ${getPartTitleFallback(partNum)}`,
          instructions: `AI Generated Practice for Part ${partNum}`,
        },
      });
    }

    const insertedQuestions = [];

    for (const q of aiParsedData.questions) {
      const dbQuestion = await prisma.question.create({
        data: {
          testPartId: devPart.id,
          questionNumber: q.questionNumber || 1,
          passage: q.passage || null,
          questionText: q.questionText || "Select the best word of response.",
          transcript: q.transcript || null,
          correctAnswer: q.correctAnswer || "A",
        },
      });

      if (q.options && Array.isArray(q.options)) {
        for (const opt of q.options) {
          await prisma.option.create({
            data: { questionId: dbQuestion.id, letter: opt.letter.toUpperCase(), text: opt.text },
          });
        }
      } else {
        for (const letChar of ["A", "B", "C", "D"]) {
          await prisma.option.create({
            data: { questionId: dbQuestion.id, letter: letChar, text: `Option ${letChar}` },
          });
        }
      }
      insertedQuestions.push(dbQuestion);
    }

    res.json({
      message: "AI Import successful and loaded into database.",
      partNumber: partNum,
      questionsCount: insertedQuestions.length,
      questions: insertedQuestions,
    });
  } catch (error) {
    console.error("Import exam error:", error);
    res.status(500).json({
      error: `Parsing and import failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// NEW: Upload files + AI processing pipeline for full TOEIC exam import
// ---------------------------------------------------------------------------

export async function uploadAndProcessExam(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { testId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Không xác định được người dùng." });
    return;
  }

  try {
    const test = await prisma.test.findUnique({ where: { id: testId } });
    if (!test) {
      res.status(404).json({ error: "Không tìm thấy đề thi." });
      return;
    }

    if (test.examType.toUpperCase() !== "TOEIC") {
      res.status(400).json({ error: "Import AI hiện chỉ hỗ trợ TOEIC." });
      return;
    }

    const multerFiles = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    if (!multerFiles) {
      res.status(400).json({ error: "Không tìm thấy file upload." });
      return;
    }

    const fileRefs: UploadedFileRef[] = [];

    const fileTypeMap: Record<string, ExamFileType> = {
      examPdf: "EXAM_PDF",
      keyLcPdf: "KEY_LC_PDF",
      keyRcImage: "KEY_RC_IMAGE",
      audioMp3: "AUDIO_MP3",
    };

    for (const [fieldName, fileType] of Object.entries(fileTypeMap)) {
      const uploaded = multerFiles[fieldName]?.[0];
      if (!uploaded?.buffer) continue;

      const ext = path.extname(uploaded.originalname) || ".bin";
      const s3Key = buildObjectKey(test.examType, testId, fileType, ext);

      await uploadObject(s3Key, uploaded.buffer, uploaded.mimetype);

      await prisma.uploadedFile.create({
        data: {
          testId,
          fileType,
          fileName: uploaded.originalname,
          filePath: s3Key,
          mimeType: uploaded.mimetype,
        },
      });

      fileRefs.push({
        fileType,
        s3Key,
        mimeType: uploaded.mimetype,
      });
    }

    if (fileRefs.length < 3) {
      res.status(400).json({
        error: "Cần upload ít nhất 3 file: đề thi (PDF), KEY LC (PDF), KEY RC (ảnh).",
      });
      return;
    }

    const progressLog: { step: string; detail: string }[] = [];

    const importJob = await prisma.ingestionJob.create({
      data: {
        testId,
        createdById: userId,
        status: IngestionStatus.IMPORTING,
        progressStep: "Direct upload import",
      },
    });

    const pipelineState = await ensurePipelineState(importJob.id, testId, "direct_import");

    try {
      const result = await processToeicExamResumable(testId, fileRefs, (p) => {
        progressLog.push(p);
      }, {
        jobId: importJob.id,
        pipelineState,
        source: "direct_import",
      });

      await prisma.ingestionJob.update({
        where: { id: importJob.id },
        data: {
          status: IngestionStatus.DONE,
          progressStep: "Done",
          resultSummary: JSON.stringify(result),
        },
      });

      res.json({
        message: `Import thành công! Tổng cộng ${result.totalQuestions} câu hỏi.`,
        jobId: importJob.id,
        totalQuestions: result.totalQuestions,
        partsSummary: result.partsSummary,
        progressLog,
        pipelineSteps: pipelineStepsSummary(pipelineState),
      });
    } catch (importError) {
      const failedStep = findLastFailedStep(pipelineState) ?? "save_db";
      await markJobFailed(importJob.id, failedStep, importError, pipelineState);
      throw importError;
    }
  } catch (error) {
    console.error("Upload and process exam error:", error);
    res.status(500).json({
      error: `Xử lý đề thi thất bại: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// New: Single multi-file ingestion job (extract + review gate)
// ---------------------------------------------------------------------------
export async function createImportJob(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { testId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Không xác định được người dùng." });
    return;
  }

  try {
    const test = await prisma.test.findUnique({ where: { id: testId } });
    if (!test) {
      res.status(404).json({ error: "Không tìm thấy đề thi." });
      return;
    }
    if (test.examType.toUpperCase() !== "TOEIC") {
      res.status(400).json({ error: "Import hiện chỉ hỗ trợ TOEIC." });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) || [];
    if (!files.length) {
      res.status(400).json({ error: "Không có file upload." });
      return;
    }
    const pdfFiles = files.filter((f) => f.mimetype === "application/pdf");
    const mp3Files = files.filter((f) => f.mimetype === "audio/mpeg" || f.mimetype === "audio/mp3");
    if (pdfFiles.length < 2) {
      res.status(400).json({
        error: "Cần ít nhất 2 file PDF (đề thi + đáp án/key). Nếu bạn có ảnh, hãy chuyển ảnh thành PDF trước khi upload.",
      });
      return;
    }
    if (mp3Files.length < 1) {
      res.status(400).json({
        error: "Cần ít nhất 1 file MP3 cho phần nghe (Part 1-4).",
      });
      return;
    }

    const job = await prisma.ingestionJob.create({
      data: {
        testId,
        createdById: userId,
        status: "QUEUED",
        progressStep: "Queued",
      },
    });

    const uploadBatchFiles: UploadedBatchFile[] = [];

    for (const file of files) {
      const s3Key = buildIntakeObjectKey(test.examType, testId, file.originalname);
      await uploadObject(s3Key, file.buffer, file.mimetype);

      await prisma.ingestionFile.create({
        data: {
          ingestionJobId: job.id,
          originalName: file.originalname,
          mimeType: file.mimetype,
          storageKey: s3Key,
        },
      });

      uploadBatchFiles.push({
        originalName: file.originalname,
        mimeType: file.mimetype,
        storageKey: s3Key,
        buffer: file.buffer,
      });
    }

    void runDocumentIngestionJob(job.id, testId, uploadBatchFiles).catch(async (error) => {
      console.error("Background ingestion job error:", error);
      const state = await loadPipelineStateForJob(job.id);
      if (state) {
        const failedStep = findLastFailedStep(state) ?? "classify";
        await markJobFailed(job.id, failedStep, error, state);
      } else {
        await prisma.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            errorMessage: error instanceof Error ? error.message : String(error),
            progressStep: "Failed",
          },
        });
      }
    });

    res.status(201).json({
      jobId: job.id,
      status: "QUEUED",
      reviewRequired: false,
    });
  } catch (error) {
    console.error("Create import job error:", error);
    res.status(500).json({
      error: `Tạo import job thất bại: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export async function getImportJob(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { jobId } = req.params;
  try {
    const job = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      include: { files: true, draft: true, test: { select: { id: true, title: true } } },
    });
    if (!job) {
      res.status(404).json({ error: "Không tìm thấy import job." });
      return;
    }
    const pipelineState = parsePipelineState(job.draft?.pipelineState);
    res.json({
      ...job,
      pipelineSteps: pipelineState ? pipelineStepsSummary(pipelineState) : null,
    });
  } catch (error) {
    console.error("Get import job error:", error);
    res.status(500).json({ error: "Không thể tải trạng thái import job." });
  }
}

export async function submitImportReview(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { jobId } = req.params;
  const { assignments } = req.body as {
    assignments?: Array<{ fileId: string; role: "EXAM_DOC" | "LISTENING_KEY_DOC" | "READING_KEY_IMAGE" | "AUDIO_FILE" | "UNKNOWN" }>;
  };

  try {
    const job = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      include: { files: true },
    });
    if (!job) {
      res.status(404).json({ error: "Không tìm thấy import job." });
      return;
    }

    if (assignments?.length) {
      for (const assign of assignments) {
        await prisma.ingestionFile.update({
          where: { id: assign.fileId },
          data: { detectedRole: assign.role, confidence: 1 },
        });
      }
    }

    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: "IMPORTING",
        reviewRequired: false,
        progressStep: "Importing after review",
        errorMessage: null,
      },
    });

    void importAfterReview(jobId, job.testId).catch(async (error) => {
      console.error("Import after review error:", error);
    });

    const updated = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      include: { draft: true, files: true },
    });
    res.json(updated ?? { id: jobId, status: "IMPORTING", reviewRequired: false });
  } catch (error) {
    console.error("Submit import review error:", error);
    res.status(500).json({
      error: `Xác nhận review thất bại: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export async function resumeImportJobHandler(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const { jobId } = req.params;

  try {
    void resumeImportJob(jobId).catch((error) => {
      console.error("Resume import job error:", error);
    });

    const job = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, progressStep: true, lastFailedStep: true },
    });

    res.json({
      jobId,
      status: job?.status ?? IngestionStatus.IMPORTING,
      progressStep: job?.progressStep ?? "Resuming import",
      lastFailedStep: job?.lastFailedStep,
      message: "Đang tiếp tục import từ checkpoint đã lưu.",
    });
  } catch (error) {
    console.error("Resume import job handler error:", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Utility
function getPartTitleFallback(num: number): string {
  switch (num) {
    case 1: return "Mô tả Hình ảnh";
    case 2: return "Hỏi - Đáp";
    case 3: return "Hội thoại";
    case 4: return "Bài nói ngắn";
    case 5: return "Hoàn thành Câu";
    case 6: return "Điền vào Đoạn văn";
    case 7: return "Đọc hiểu";
    default: return "Phần TOEIC";
  }
}
