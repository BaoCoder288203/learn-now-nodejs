import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { describe, it } from "node:test";
import { parseListeningParts, part1ParserInternals } from "./listening.js";

const DE3_KEY_LC = "/Users/nguyentrongbao/Documents/Personal/Toeic/de3/KEY LC + TRANSCRIPT.pdf";

describe("parseListeningParts Part 1", () => {
  it("parses interleaved KEY LC with quoted (B) and assigns 4 options per question", () => {
    const fixture = `
1 (A)
2 (B)
3 (A)
4 (B)
5 (C)
6 (D)

(A) Some people are sitting in a car.
51 (A)
52 (D)
(B) Some people are facing each other.
(C) A woman is opening her handbag.
(D) A man is removing his jacket.

PART1
1

(A) He's looking in a file drawer.
3
'(B) He's printing some documents.
(C) He's stacking some folders.
(D) He's putting on his glasses.

(A) Clothing is hanging on racks.
(B) Lights have been turned off in the store.
(C) A woman is folding a coat.
(D) A woman is opening a garment bag.

PART2
7 (A)
`;

    const parts = parseListeningParts(fixture, "");
    const part1 = parts.find((p) => p.partNumber === 1)!;
    assert.equal(part1.groups.length, 6);

    const q1 = part1.groups[0]!.questions[0]!;
    assert.equal(q1.options.length, 4);
    assert.match(q1.options[0]!, /file drawer/i);
    assert.match(q1.options[1]!, /printing/i);
    assert.match(q1.options[2]!, /stacking/i);
    assert.match(q1.options[3]!, /glasses/i);
    assert.equal(q1.correctAnswer, "A");

    const q3 = part1.groups[2]!.questions[0]!;
    assert.equal(q3.options.length, 4);
    assert.match(q3.options[0]!, /sitting in a car/i);
    assert.equal(q3.correctAnswer, "A");
  });

  it("parses de3 KEY LC PDF text when available", () => {
    let text: string;
    try {
      text = execSync(`pdftotext "${DE3_KEY_LC}" -`, { encoding: "utf8" });
    } catch {
      return;
    }

    const parts = parseListeningParts(text, "");
    const part1 = parts.find((p) => p.partNumber === 1)!;

    for (let q = 1; q <= 6; q++) {
      const question = part1.groups[q - 1]!.questions[0]!;
      assert.equal(question.questionNumber, q);
      assert.equal(question.options.length, 4, `Q${q} must have 4 options`);
      assert.ok(
        question.options.every((o) => o && o !== "-"),
        `Q${q} must not have placeholder options`
      );
    }

    assert.match(part1.groups[0]!.questions[0]!.options[0]!, /f\s*ile drawer/i);
    assert.match(part1.groups[2]!.questions[0]!.options[0]!, /sitting in a car/i);
  });
});

describe("parseListeningParts Part 3/4", () => {
  it("keeps wrapped graphic question lines together", () => {
    const fixture = `
PART 3
32 (A)
33 (B)
34 (C)

32.
Look at the graphic. Which parking area w ill be
closed?
(A) Area A
(B) Area B
(C) Area C
(D) Area D
33.
What does the speaker suggest?
(A) Calling a client
(B) Moving a car
(C) Sending a form
(D) Reading a notice
34.
When will the work begin?
(A) On Monday
(B) On Tuesday
(C) On Wednesday
(D) On Thursday
PART 4
71 (A)
`;

    const parts = parseListeningParts(fixture, "");
    const part3 = parts.find((p) => p.partNumber === 3)!;
    const q32 = part3.groups[0]!.questions[0]!;

    assert.equal(
      q32.questionText,
      "Look at the graphic. Which parking area w ill be closed?"
    );
  });
});

describe("part1ParserInternals", () => {
  it("extracts 4-option English sets from PART1 section", () => {
    const sets = part1ParserInternals.extractPart1PhotoOptionSets(`
PART1
(A) He's looking in a file drawer.
'(B) He's printing some documents.
(C) He's stacking some folders.
(D) He's putting on his glasses.
PART2
`);
    assert.equal(sets.length, 1);
    assert.match(sets[0]!.A, /file drawer/i);
    assert.match(sets[0]!.B, /printing/i);
  });
});
