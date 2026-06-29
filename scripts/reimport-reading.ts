/**
 * One-off: re-run reading parse + assets + save_db for Test #3 (Đề 3).
 * Usage: PYMUPDF_URL=http://localhost:8081 npx tsx scripts/reimport-reading.ts
 */
import "dotenv/config";
import { prisma } from "../src/db.js";
import { processToeicExamPyMuPdfResumable } from "../src/services/pymupdfExamPipeline.js";
import type { ExamFileType } from "../src/services/s3ObjectKey.js";
import type { UploadedFileRef } from "../src/services/examProcessingService.js";

const TEST_ID = "a6bc3bac-983d-4426-86c0-ad2f31e0b864";
const JOB_ID = "44e077a5-f8a2-4798-85c6-6589addaf292";

const RESET_STEPS = ["toeic_parse_reading", "gemini_normalize", "save_assets", "save_db"] as const;

async function main() {
  process.env.PYMUPDF_URL = process.env.PYMUPDF_URL?.includes("pymupdf:")
    ? "http://localhost:8081"
    : process.env.PYMUPDF_URL || "http://localhost:8081";

  const files = await prisma.uploadedFile.findMany({ where: { testId: TEST_ID } });
  const refs: UploadedFileRef[] = files.map((f) => ({
    fileType: f.fileType as ExamFileType,
    s3Key: f.filePath,
    mimeType: f.mimeType,
  }));

  console.log("[reimport] PYMUPDF_URL =", process.env.PYMUPDF_URL);
  console.log("[reimport] resetting steps:", RESET_STEPS.join(", "));
  const result = await processToeicExamPyMuPdfResumable(TEST_ID, refs, (p) => {
    console.log(`[progress] ${p.step}: ${p.detail}`);
  }, {
    jobId: JOB_ID,
    source: "import_job",
  });

  console.log("[reimport] done:", result.totalQuestions, "questions");

  const rows = await prisma.$queryRaw<
    { partNumber: number; groups: bigint; with_image: bigint; with_regions: bigint }[]
  >`
    SELECT tp."partNumber"::int AS "partNumber",
           COUNT(qg.id) AS groups,
           COUNT(qg.id) FILTER (WHERE qg."imageUrl" IS NOT NULL) AS with_image,
           COUNT(qg.id) FILTER (WHERE qg."textRegions" IS NOT NULL) AS with_regions
    FROM "TestPart" tp
    JOIN "QuestionGroup" qg ON qg."testPartId" = tp.id
    WHERE tp."testId" = ${TEST_ID} AND tp."partNumber" BETWEEN 5 AND 7
    GROUP BY tp."partNumber"
    ORDER BY tp."partNumber"
  `;
  console.table(rows);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
