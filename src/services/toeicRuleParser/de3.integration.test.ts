import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { parseKeyRcFromText } from "./keyRc.js";
import { parseListeningParts, extractConversationTranscripts } from "./listening.js";
import { parseToeicDocument } from "./index.js";
import type { PyMuPdfDocumentLayout } from "../pymupdfClient.js";

const DE3_DIR = "/Users/nguyentrongbao/Documents/Personal/Toeic/de3";
const DE3_EXAM = `${DE3_DIR}/ĐỀ.pdf`;
const DE3_KEY_LC = `${DE3_DIR}/KEY LC + TRANSCRIPT.pdf`;
const DE3_KEY_RC = `${DE3_DIR}/KEY RC.pdf`;

const fixturesAvailable =
  existsSync(DE3_EXAM) && existsSync(DE3_KEY_LC) && existsSync(DE3_KEY_RC);

function pdfToText(path: string): string {
  return execSync(`pdftotext "${path}" -`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function pdfLayout(path: string): PyMuPdfDocumentLayout {
  const raw = execSync(
    `curl -s -X POST http://localhost:8081/extract-layout -F "file=@${path}"`,
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(raw) as PyMuPdfDocumentLayout;
}

function pymupdfAvailable(): boolean {
  try {
    execSync("curl -s http://localhost:8081/health", { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

describe("Đề 3 golden fixtures", { skip: !fixturesAvailable }, () => {
  it("parses 200 questions with Part 1 images and Part 6/7 passages", () => {
    if (!pymupdfAvailable()) return;

    const examText = pdfToText(DE3_EXAM);
    const keyLcText = pdfToText(DE3_KEY_LC);
    const examLayout = pdfLayout(DE3_EXAM);

    let rcAnswers = parseKeyRcFromText(pdfToText(DE3_KEY_RC));
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
    assert.ok(total >= 190, `expected >=190 questions, got ${total}`);

    const part1 = doc.parts.find((p) => p.partNumber === 1)!;
    const p1WithBbox = part1.groups.filter((g) => g.imageBbox && g.sourcePage);
    assert.equal(p1WithBbox.length, 6, "Part 1 must have 6 photo bboxes");

    const part3 = doc.parts.find((p) => p.partNumber === 3)!;
    const p3Transcripts = new Set(part3.groups.map((g) => g.transcript?.slice(0, 80)));
    assert.ok(p3Transcripts.size >= 10, "Part 3 transcripts must be unique per group");

    const part6 = doc.parts.find((p) => p.partNumber === 6)!;
    assert.equal(part6.groups.length, 4, "Part 6 must have 4 passage groups");
    for (const g of part6.groups) {
      assert.ok(g.passage && g.passage.length > 80, `P6 Q${g.questions[0]?.questionNumber} passage`);
      assert.equal(g.questions.length, 4, "each P6 group has 4 questions");
    }
    assert.ok(
      part6.groups.filter((g) => g.imageBbox && g.sourcePage).length >= 3,
      "P6 needs passage bbox on most groups"
    );

    const part7 = doc.parts.find((p) => p.partNumber === 7)!;
    const p7WithPassage = part7.groups.filter((g) => g.passage && g.passage.length > 40);
    assert.ok(p7WithPassage.length >= 15, "Part 7 must have >=15 passage groups");
    const p7Weak = part7.groups.filter((g) => !g.passage || g.passage.length < 20);
    assert.equal(p7Weak.length, 0, `Part 7 weak passages: ${p7Weak.map((g) => g.questions[0]?.questionNumber).join(",")}`);

    const q131 = part6.groups[0]!.questions.find((q) => q.questionNumber === 131)!;
    assert.match(q131.options[0]!, /competitive|transformed/i);
  });

  it("extracts distinct Part 3 transcripts from KEY LC", () => {
    const keyLcText = pdfToText(DE3_KEY_LC);
    const sections = keyLcText.split(/PART\s*3/i);
    const section = "PART3" + (sections[1] ?? "");
    const map = extractConversationTranscripts(section, 3);
    assert.ok(map.size >= 10);
    const first = map.get(32) ?? "";
    const second = map.get(35) ?? map.get(38) ?? "";
    assert.ok(first.length > 50);
    assert.ok(second.length > 50);
    assert.notEqual(first.slice(0, 50), second.slice(0, 50));
  });

  it("Part 1 options from KEY LC", () => {
    const keyLcText = pdfToText(DE3_KEY_LC);
    const parts = parseListeningParts(keyLcText, "");
    const part1 = parts.find((p) => p.partNumber === 1)!;
    for (let q = 1; q <= 6; q++) {
      const question = part1.groups[q - 1]!.questions[0]!;
      assert.equal(question.options.length, 4);
      assert.ok(question.options.every((o) => o && o !== "-"));
    }
  });
});
