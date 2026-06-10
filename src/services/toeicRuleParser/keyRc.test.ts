import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseKeyRcFromText } from "./keyRc.js";

describe("parseKeyRcFromText", () => {
  it("parses numbered answers 101-200", () => {
    const text = `
    101. A
    102 B
    103) C
    150: D
    200 - A
    `;
    const map = parseKeyRcFromText(text);
    assert.equal(map["101"], "A");
    assert.equal(map["102"], "B");
    assert.equal(map["103"], "C");
    assert.equal(map["150"], "D");
    assert.equal(map["200"], "A");
  });
});
