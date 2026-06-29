import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { parseKeyRcFromText } from "./keyRc.js";
import { parseToeicDocument } from "./index.js";
import { isFullPageBbox } from "./columnLayout.js";
import type { PyMuPdfDocumentLayout } from "../pymupdfClient.js";

const DE4_DIR = "/Users/nguyentrongbao/Documents/Personal/Toeic/Đề 4";
const DE4_EXAM = `${DE4_DIR}/ĐỀ.pdf`;
const DE4_KEY_LC = `${DE4_DIR}/KEY LC + TRANSCRIPT.pdf`;
const DE4_KEY_RC = `${DE4_DIR}/KEY RC.pdf`;

const fixturesAvailable =
  existsSync(DE4_EXAM) && existsSync(DE4_KEY_LC) && existsSync(DE4_KEY_RC);

function pdfToText(path: string): string {
  return execSync(`pdftotext "${path}" -`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function pymupdfPort(): string {
  for (const port of ["8081", "8082"]) {
    try {
      execSync(`curl -s http://localhost:${port}/health`, { encoding: "utf8" });
      return port;
    } catch {
      /* try next */
    }
  }
  throw new Error("PyMuPDF sidecar not available on 8081 or 8082");
}

function pdfLayout(path: string): PyMuPdfDocumentLayout {
  const port = pymupdfPort();
  const raw = execSync(
    `curl -s -X POST http://localhost:${port}/extract-layout -F "file=@${path}"`,
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(raw) as PyMuPdfDocumentLayout;
}

function pymupdfAvailable(): boolean {
  try {
    pymupdfPort();
    return true;
  } catch {
    return false;
  }
}

describe("Đề 4 golden fixtures", { skip: !fixturesAvailable }, () => {
  it("parses >=195 questions without column bleed on P5 Q101", () => {
    if (!pymupdfAvailable()) return;

    const examText = pdfToText(DE4_EXAM);
    const keyLcText = pdfToText(DE4_KEY_LC);
    const examLayout = pdfLayout(DE4_EXAM);

    let rcAnswers = parseKeyRcFromText(pdfToText(DE4_KEY_RC));
    if (Object.keys(rcAnswers).length < 50) {
      rcAnswers = {};
      for (let i = 101; i <= 200; i++) rcAnswers[String(i)] = "A";
    }

    const doc = parseToeicDocument({
      examText,
      examLayout,
      keyLcText,
      rcAnswers,
    });

    const total = doc.parts.reduce(
      (sum, p) => sum + p.groups.reduce((gs, g) => gs + g.questions.length, 0),
      0
    );
    assert.ok(total >= 195, `expected >=195 questions, got ${total}`);

    const part5 = doc.parts.find((p) => p.partNumber === 5)!;
    assert.ok(part5.groups.length >= 1, "Part 5 must have page groups");

    const q101 = part5.groups.flatMap((g) => g.questions).find((q) => q.questionNumber === 101);
    assert.ok(q101, "Q101 must be parsed");
    assert.doesNotMatch(q101!.questionText, /\b105\b/, "Q101 must not bleed into Q105 column");

    const p5WithPage = part5.groups.filter(
      (g) => g.sourcePage && g.imageBbox && isFullPageBbox(g.imageBbox)
    );
    assert.ok(p5WithPage.length >= 1, "P5 groups need sourcePage + full page bbox");

    const p5Pages = new Set(part5.groups.map((g) => g.sourcePage).filter(Boolean));
    assert.ok(p5Pages.size >= 1, "P5 must assign source pages");

    const part6 = doc.parts.find((p) => p.partNumber === 6)!;
    assert.equal(part6.groups.length, 4, "Part 6 must have 4 passage groups");
    for (const g of part6.groups) {
      assert.ok(g.sourcePage, `P6 Q${g.questions[0]?.questionNumber} needs sourcePage`);
      assert.ok(g.imageBbox && isFullPageBbox(g.imageBbox), "P6 groups use full page bbox");
    }

    const part7 = doc.parts.find((p) => p.partNumber === 7)!;
    assert.ok(part7.groups.length >= 15, "Part 7 must have >=15 passage groups");

    const readingPages = new Set<number>();
    for (const part of [part5, part6, part7]) {
      for (const g of part.groups) {
        if (g.sourcePage) readingPages.add(g.sourcePage);
      }
    }
    assert.ok(readingPages.size >= 3, "P5–P7 must use distinct reading pages");
  });
});
