import { Router } from "express";
import multer from "multer";
import { register, login, refresh, requestOtp, verifyOtp } from "../controllers/authController.js";
import {
  getTests,
  getTestDetails,
  startTestAttempt,
  submitAnswer,
  selectWordInTest,
  finishTestAttempt,
  getSelectedWordsByAttempt,
  getUserAttempts,
  getAttemptResult,
} from "../controllers/testController.js";
import {
  getVocabList,
  saveVocabWord,
  updateVocabStatus,
  deleteVocabWord,
} from "../controllers/vocabController.js";
import {
  togglePublishTest,
  editQuestion,
  createTestManually,
  getUserStatistics,
  importToeicExamViaAi,
  uploadAndProcessExam,
  createImportJob,
  getImportJob,
  submitImportReview,
} from "../controllers/adminController.js";
import { authenticateJWT, requireAdmin } from "../middlewares/authMiddleware.js";

const router = Router();

// ---------------------------------------------------------------------------
// Multer config for exam file uploads
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max per file
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "audio/mpeg",
      "audio/mp3",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Loại file không được hỗ trợ: ${file.mimetype}`));
    }
  },
});

const examUploadFields = upload.fields([
  { name: "examPdf", maxCount: 1 },
  { name: "keyLcPdf", maxCount: 1 },
  { name: "keyRcImage", maxCount: 1 },
  { name: "audioMp3", maxCount: 1 },
]);
const batchUploadFiles = upload.array("files", 20);

// -------------------------------------------------------------
// PUBLIC & AUTHENTICATION ENDPOINTS
// -------------------------------------------------------------
router.post("/auth/register", register);
router.post("/auth/register/request-otp", requestOtp);
router.post("/auth/register/verify-otp", verifyOtp);
router.post("/auth/login", login);
router.post("/auth/refresh", refresh);

// -------------------------------------------------------------
// USER - TEST AND PRACTICE PATHS (JWT PROTECTED)
// -------------------------------------------------------------
router.get("/tests", authenticateJWT, getTests);
router.get("/tests/:testId", authenticateJWT, getTestDetails);
router.post("/tests/attempts", authenticateJWT, startTestAttempt);
router.post("/tests/answers", authenticateJWT, submitAnswer);
router.post("/tests/select-word", authenticateJWT, selectWordInTest);
router.post("/tests/finish", authenticateJWT, finishTestAttempt);
router.get("/tests/attempts/:attemptId", authenticateJWT, getAttemptResult);
router.get("/tests/attempts/:attemptId/words", authenticateJWT, getSelectedWordsByAttempt);
router.get("/attempts", authenticateJWT, getUserAttempts);

// -------------------------------------------------------------
// USER - STUDY NOTEBOOK VOCABULARY PATHS (JWT PROTECTED)
// -------------------------------------------------------------
router.get("/vocab", authenticateJWT, getVocabList);
router.post("/vocab", authenticateJWT, saveVocabWord);
router.put("/vocab/:vocabId/status", authenticateJWT, updateVocabStatus);
router.delete("/vocab/:vocabId", authenticateJWT, deleteVocabWord);

// -------------------------------------------------------------
// ADMIN PATHS (JWT & ADMIN ROLE REQUIRED)
// -------------------------------------------------------------
router.post("/admin/tests/manual", authenticateJWT, requireAdmin, createTestManually);
router.put("/admin/tests/:testId/publish", authenticateJWT, requireAdmin, togglePublishTest);
router.put("/admin/questions/:questionId", authenticateJWT, requireAdmin, editQuestion);
router.get("/admin/stats", authenticateJWT, requireAdmin, getUserStatistics);
router.post("/admin/tests/import", authenticateJWT, requireAdmin, importToeicExamViaAi);
router.post(
  "/admin/tests/:testId/upload-and-process",
  authenticateJWT,
  requireAdmin,
  examUploadFields,
  uploadAndProcessExam
);
router.post(
  "/admin/tests/:testId/import-jobs",
  authenticateJWT,
  requireAdmin,
  batchUploadFiles,
  createImportJob
);
router.get("/admin/import-jobs/:jobId", authenticateJWT, requireAdmin, getImportJob);
router.post(
  "/admin/import-jobs/:jobId/review-submit",
  authenticateJWT,
  requireAdmin,
  submitImportReview
);

export default router;
