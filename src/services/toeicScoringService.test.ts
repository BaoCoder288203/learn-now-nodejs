import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeToeicScore } from "./toeicScoringService.js";

describe("computeToeicScore", () => {
  const fullScope = [
    ...Array.from({ length: 100 }, (_, i) => ({
      id: `l-${i}`,
      partNumber: i < 50 ? 1 : 2,
    })),
    ...Array.from({ length: 100 }, (_, i) => ({
      id: `r-${i}`,
      partNumber: i < 50 ? 5 : 6,
    })),
  ];

  it("counts unanswered questions as incorrect for full test", () => {
    const answers = fullScope.slice(0, 80).map((q, i) => ({
      questionId: q.id,
      isCorrect: i < 60,
    }));

    const result = computeToeicScore(fullScope, answers, null);

    assert.equal(result.listeningTotal, 100);
    assert.equal(result.readingTotal, 100);
    assert.equal(result.listeningCorrect + result.readingCorrect, 60);
    assert.ok(result.totalScore < 990);
  });

  it("scores part practice on single skill max 495", () => {
    const part5Scope = Array.from({ length: 30 }, (_, i) => ({
      id: `p5-${i}`,
      partNumber: 5,
    }));

    const answers = part5Scope.map((q, i) => ({
      questionId: q.id,
      isCorrect: i < 24,
    }));

    const result = computeToeicScore(part5Scope, answers, 5);

    assert.equal(result.isPartPractice, true);
    assert.equal(result.readingCorrect, 24);
    assert.equal(result.readingTotal, 30);
    assert.equal(result.readingScore, Math.round((24 / 30) * 495));
    assert.equal(result.listeningScore, 0);
    assert.equal(result.totalScore, result.readingScore);
  });
});
