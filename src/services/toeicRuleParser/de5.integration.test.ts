import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseKeyRcFromText } from "./keyRc.js";
import { parseToeicDocument } from "./index.js";
import { isFullPageBbox } from "./columnLayout.js";
import type { PyMuPdfDocumentLayout } from "../pymupdfClient.js";

const DE5_DIR = process.env.DE5_DIR ?? "/Users/nguyentrongbao/Documents/Personal/Toeic/de5";

function findFile(dir: string, pattern: RegExp): string | undefined {
  try {
    return readdirSync(dir).find((name) => pattern.test(name));
  } catch {
    return undefined;
  }
}

const examFile = findFile(DE5_DIR, /^đ/i) ?? findFile(DE5_DIR, /^de/i);
const keyLcFile = findFile(DE5_DIR, /KEY LC/i);
const keyRcFile =
  findFile(DE5_DIR, /KEY RC.*\.pdf/i) ?? findFile(DE5_DIR, /KEY RC/i);

const DE5_EXAM = examFile ? join(DE5_DIR, examFile) : "";
const DE5_KEY_LC = keyLcFile ? join(DE5_DIR, keyLcFile) : "";
const DE5_KEY_RC = keyRcFile ? join(DE5_DIR, keyRcFile) : "";

const fixturesAvailable =
  existsSync(DE5_EXAM) && existsSync(DE5_KEY_LC) && existsSync(DE5_KEY_RC);

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

function countPartQuestions(partNumber: number, doc: ReturnType<typeof parseToeicDocument>): number {
  const part = doc.parts.find((p) => p.partNumber === partNumber);
  return part?.groups.reduce((sum, g) => sum + g.questions.length, 0) ?? 0;
}

describe("Đề 5 golden fixtures", { skip: !fixturesAvailable }, () => {
  it("parses 200/200 questions without column bleed on P5 Q101", () => {
    if (!pymupdfAvailable()) return;

    const examText = pdfToText(DE5_EXAM);
    const keyLcText = pdfToText(DE5_KEY_LC);
    const examLayout = pdfLayout(DE5_EXAM);

    let rcAnswers = parseKeyRcFromText(pdfToText(DE5_KEY_RC));
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

    assert.ok(countPartQuestions(5, doc) >= 27, "Part 5 must have >=27 questions");
    assert.equal(countPartQuestions(6, doc), 16, "Part 6 must have 16 questions");
    assert.equal(countPartQuestions(7, doc), 54, "Part 7 must have 54 questions");

    const readingTotal = [5, 6, 7].reduce((s, pn) => s + countPartQuestions(pn, doc), 0);
    assert.ok(readingTotal >= 97, `expected >=97 reading questions, got ${readingTotal}`);

    const part5 = doc.parts.find((p) => p.partNumber === 5)!;
    const q101 = part5.groups.flatMap((g) => g.questions).find((q) => q.questionNumber === 101);
    assert.ok(q101, "Q101 must be parsed");
    assert.doesNotMatch(q101!.questionText, /\b105\b/, "Q101 must not bleed into Q105 column");

    for (const partNum of [5, 6, 7] as const) {
      const part = doc.parts.find((p) => p.partNumber === partNum)!;
      for (const g of part.groups) {
        assert.ok(g.imageBbox && isFullPageBbox(g.imageBbox), `P${partNum} groups use full page bbox`);
      }
    }
  });
});
