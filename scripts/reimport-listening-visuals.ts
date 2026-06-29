/**
 * Re-run listening parse + normalize P3/P4 + assets + save_db for Test #3.
 * Usage: PYMUPDF_URL=http://localhost:8081 npx tsx scripts/reimport-listening-visuals.ts
 */
import dotenv from "dotenv";
dotenv.config({ override: false });
import { prisma } from "../src/db.js";
import { processToeicExamPyMuPdfResumable } from "../src/services/pymupdfExamPipeline.js";
import { loadPipelineStateForJob } from "../src/services/importPipelinePersistence.js";
import type { ExamFileType } from "../src/services/s3ObjectKey.js";
import type { UploadedFileRef } from "../src/services/examProcessingService.js";
import {
  createEmptyPipelineStateV2,
  type PipelineStepId,
} from "../src/services/importPipelineState.js";

const TEST_ID = "d1f26ac2-b500-413e-9d99-e3f35cfba728";
const JOB_ID = "13655d88-4edf-4b86-80de-2e29c6922d20";

const RESET_STEPS: PipelineStepId[] = [
  "toeic_parse_listening",
  "gemini_normalize",
  "gemini_normalize_3",
  "gemini_normalize_4",
  "save_assets",
  "save_db",
];

async function main() {
  const dbHost = process.env.DATABASE_URL
    ? new URL(process.env.DATABASE_URL).hostname
    : "localhost";
  if (dbHost === "localhost" || dbHost === "127.0.0.1") {
    process.env.PYMUPDF_URL = process.env.PYMUPDF_URL?.includes("pymupdf:")
      ? "http://localhost:8081"
      : process.env.PYMUPDF_URL || "http://localhost:8081";
  } else if (!process.env.PYMUPDF_URL) {
    process.env.PYMUPDF_URL = "http://pymupdf:8081";
  }

  const state =
    (await loadPipelineStateForJob(JOB_ID)) ??
    createEmptyPipelineStateV2(TEST_ID, { jobId: JOB_ID, source: "import_job" });

  console.log("[reimport-listening] DATABASE_URL host =", new URL(process.env.DATABASE_URL!).hostname);

  for (const stepId of RESET_STEPS) {
    state.steps[stepId] = { status: "pending", updatedAt: new Date().toISOString() };
  }

  const files = await prisma.uploadedFile.findMany({ where: { testId: TEST_ID } });
  const refs: UploadedFileRef[] = files.map((f) => ({
    fileType: f.fileType as ExamFileType,
    s3Key: f.filePath,
    mimeType: f.mimeType,
  }));

  console.log("[reimport-listening] PYMUPDF_URL =", process.env.PYMUPDF_URL);
  console.log("[reimport-listening] resetting:", RESET_STEPS.join(", "));

  const result = await processToeicExamPyMuPdfResumable(
    TEST_ID,
    refs,
    (p) => console.log(`[progress] ${p.step}: ${p.detail}`),
    { jobId: JOB_ID, pipelineState: state, source: "import_job" }
  );

  console.log("[reimport-listening] done:", result.totalQuestions, "questions");

  const groupRows = await prisma.$queryRaw<
    { part: number; groups: bigint; with_image: bigint }[]
  >`
    SELECT tp."partNumber"::int AS part,
           COUNT(qg.id) AS groups,
           COUNT(qg.id) FILTER (WHERE qg."imageUrl" IS NOT NULL) AS with_image
    FROM "TestPart" tp
    JOIN "QuestionGroup" qg ON qg."testPartId" = tp.id
    WHERE tp."testId" = ${TEST_ID} AND tp."partNumber" IN (3, 4)
    GROUP BY tp."partNumber"
    ORDER BY tp."partNumber"
  `;
  console.table(groupRows);

  const graphicRows = await prisma.$queryRaw<
    { part: number; qnum: number; imageUrl: string | null }[]
  >`
    SELECT tp."partNumber"::int AS part,
           q."questionNumber"::int AS qnum,
           qg."imageUrl" AS "imageUrl"
    FROM "Test" t
    JOIN "TestPart" tp ON tp."testId" = t.id
    JOIN "Question" q ON q."testPartId" = tp.id
    LEFT JOIN "QuestionGroup" qg ON qg.id = q."questionGroupId"
    WHERE t.id = ${TEST_ID}
      AND tp."partNumber" IN (3, 4)
      AND q."questionText" ~* 'look at the graphic'
    ORDER BY q."questionNumber"
  `;
  console.table(graphicRows);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
