import { Router } from "express";
import { register, login, refresh } from "../controllers/authController.js";
import {
  getTests,
  getTestDetails,
  startTestAttempt,
  submitAnswer,
  selectWordInTest,
  finishTestAttempt,
  getSelectedWordsByAttempt,
  getUserAttempts
} from "../controllers/testController.js";
import {
  getVocabList,
  saveVocabWord,
  updateVocabStatus,
  deleteVocabWord
} from "../controllers/vocabController.js";
import {
  togglePublishTest,
  editQuestion,
  createTestManually,
  getUserStatistics,
  importToeicExamViaAi
} from "../controllers/adminController.js";
import { authenticateJWT, requireAdmin } from "../middlewares/authMiddleware.js";

const router = Router();

// -------------------------------------------------------------
// PUBLIC & AUTHENTICATION ENDPOINTS
// -------------------------------------------------------------
router.post("/auth/register", register);
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

export default router;
