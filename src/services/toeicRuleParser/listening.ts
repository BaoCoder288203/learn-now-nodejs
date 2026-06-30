import type { RawToeicGroup, RawToeicPart } from "./types.js";
import {
  LC_ANSWER_KEY_LINE_RE,
  OPTION_LINE_RE,
  PART_RANGES,
  splitByPartHeaders,
} from "./patterns.js";

type OptionLetter = "A" | "B" | "C" | "D";
type PhotoOptionSet = Record<OptionLetter, string>;
type PhotoOptionSetWithLine = PhotoOptionSet & { startLine: number };

function normalizeOptionLine(line: string): string {
  return line.trim().replace(/^['"]+/, "");
}

function isAnswerKeyLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (LC_ANSWER_KEY_LINE_RE.test(trimmed)) return true;
  if (/^\d{1,3}\s*\([A-D]\)$/i.test(trimmed)) return true;
  return false;
}

function isPhotoStatement(text: string): boolean {
  const t = text.trim();
  if (t.length < 10) return false;
  if (/[§€~{}\\|]/.test(t)) return false;
  if (/[^\x00-\x7F]{2,}/.test(t)) return false;

  const letters = (t.match(/[a-zA-Z]/g) ?? []).length;
  if (letters < t.length * 0.5) return false;
  if (!/^[A-Z("(]/.test(t)) return false;

  return /\b(He's|She's|They're|Some|Clothing|Books|Lights|flag|ship|workers|armchairs|barrier|boarding|cart|wheelbarrow|garment|folding|stacking|printing|removing|facing|looking|sitting|putting|opening|walking|hanging|people|occupied|approaching|sweeping|loaded|raised|is|are|has|have|been|man|woman)\b/i.test(
    t
  );
}

function isContinuationLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isAnswerKeyLine(trimmed)) return false;
  if (OPTION_LINE_RE.test(normalizeOptionLine(trimmed))) return false;
  if (/^\d{1,3}$/.test(trimmed)) return false;
  if (/^W-[AB]/i.test(trimmed)) return false;
  if (/^M-/i.test(trimmed)) return false;
  if (/^PART\s*\d/i.test(trimmed)) return false;
  return /[a-zA-Z]/.test(trimmed);
}

function lineNumberAt(text: string, charIndex: number): number {
  if (charIndex <= 0) return 0;
  return text.slice(0, charIndex).split("\n").length - 1;
}

function extractPart1PhotoOptionSets(text: string): PhotoOptionSetWithLine[] {
  const part1Idx = text.search(/\bPART\s*1\b/i);
  const part2Idx = part1Idx >= 0 ? text.search(/\bPART\s*2\b/i) : -1;

  const scanText =
    part1Idx >= 0 && part2Idx > part1Idx
      ? text.slice(part1Idx, part2Idx)
      : text;

  const part1Line = part1Idx >= 0 ? lineNumberAt(text, part1Idx) : 0;
  const sets = extractPart1PhotoOptionSetsFromLines(scanText.split("\n"), part1Line);

  if (sets.length >= 6) return sets.slice(0, 6);

  const beforePart1 = part1Idx > 0 ? text.slice(0, part1Idx) : "";
  if (!beforePart1) return sets;

  const prefixSets = extractPart1PhotoOptionSetsFromLines(beforePart1.split("\n"), 0);
  const merged = [...prefixSets, ...sets];
  const seen = new Set<string>();
  const unique: PhotoOptionSetWithLine[] = [];
  for (const set of merged) {
    const key = [set.A, set.B, set.C, set.D].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(set);
  }
  return unique.slice(0, 6);
}

function extractPart1PhotoOptionSetsFromLines(
  lines: string[],
  lineOffset = 0
): PhotoOptionSetWithLine[] {
  const sets: PhotoOptionSetWithLine[] = [];
  let slot = 0;
  let opts: string[] = [];
  let setStartLine = -1;

  const flush = () => {
    if (opts.length === 4) {
      sets.push({
        A: opts[0]!,
        B: opts[1]!,
        C: opts[2]!,
        D: opts[3]!,
        startLine: setStartLine >= 0 ? setStartLine : lineOffset,
      });
    }
    opts = [];
    slot = 0;
    setStartLine = -1;
  };

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo]!;
    const line = normalizeOptionLine(rawLine);
    if (!line || isAnswerKeyLine(line)) continue;

    const om = line.match(OPTION_LINE_RE);
    if (om && isPhotoStatement(om[2]!)) {
      const letter = om[1]!.toUpperCase() as OptionLetter;
      const expected = (["A", "B", "C", "D"] as const)[slot]!;

      if (letter === expected) {
        if (slot === 0) setStartLine = lineOffset + lineNo;
        opts.push(om[2]!.trim());
        slot += 1;
        if (slot === 4) flush();
      } else if (letter === "A") {
        if (opts.length > 0) flush();
        setStartLine = lineOffset + lineNo;
        opts = [om[2]!.trim()];
        slot = 1;
      }
      continue;
    }

    if (opts.length > 0 && slot > 0 && isContinuationLine(line)) {
      opts[opts.length - 1] = `${opts[opts.length - 1]!} ${line.trim()}`.trim();
    }
  }

  flush();
  return sets;
}

function normalizeOptionText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function orderPart1SetsForQuestions(
  sets: PhotoOptionSetWithLine[],
  text: string
): PhotoOptionSetWithLine[] {
  const sorted = [...sets].sort((a, b) => a.startLine - b.startLine);
  const part1Idx = text.search(/\bPART\s*1\b/i);
  const part1Line = part1Idx >= 0 ? lineNumberAt(text, part1Idx) : Number.MAX_SAFE_INTEGER;
  const prefix = sorted.filter((set) => set.startLine < part1Line);
  const inPart1 = sorted.filter((set) => set.startLine >= part1Line);

  if (prefix.length > 0 && inPart1.length > 0) {
    const ordered = [...inPart1];
    prefix.forEach((set, i) => {
      ordered.splice(Math.min(2 + i, ordered.length), 0, set);
    });
    return ordered.slice(0, 6);
  }

  return sorted.slice(0, 6);
}

function assignPart1SetsToQuestions(
  sets: PhotoOptionSetWithLine[],
  _keyAnswers: Record<number, string>,
  lcKeyText: string
): Map<number, PhotoOptionSet> {
  const assignment = new Map<number, PhotoOptionSet>();
  const ordered = orderPart1SetsForQuestions(sets, lcKeyText);

  for (let q = 1; q <= 6; q++) {
    const set = ordered[q - 1];
    if (!set) continue;
    const { startLine: _startLine, ...opts } = set;
    assignment.set(q, opts);
  }

  return assignment;
}

function parseListeningKeyAnswers(lcKeyText: string, start: number, end: number): Record<number, string> {
  const answers: Record<number, string> = {};
  const keyLineRes = [
    /^\s*(\d{1,3})\s*\(([A-D])\)\s*$/i,
    /^\s*(\d{1,3})\s*[\.\):]\s*([A-D])\s*$/i,
  ];

  for (const line of lcKeyText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const re of keyLineRes) {
      const m = trimmed.match(re);
      if (!m) continue;
      const q = Number(m[1]);
      if (q < start || q > end) continue;
      if (answers[q]) continue;
      answers[q] = m[2]!.toUpperCase();
      break;
    }
  }

  return answers;
}

const GROUP_RANGE_RE = /^\s*(\d{1,3})\s*-\s*(\d{1,3})\b/;

function cleanTranscriptText(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^PART\s*\d/i.test(l)) return false;
      if (GROUP_RANGE_RE.test(l)) return false;
      if (/^TEST\s+\d/i.test(l)) return false;
      if (/^GO ON TO THE NEXT PAGE/i.test(l)) return false;
      if (LC_ANSWER_KEY_LINE_RE.test(l)) return false;
      if (/^[\x00-\x7F]*[^\x00-\x7F]{3,}/.test(l)) return false;
      return true;
    })
    .join("\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Extract one transcript per conversation group from KEY LC section text. */
export function extractConversationTranscripts(
  sectionText: string,
  partNumber: 3 | 4
): Map<number, string> {
  const range = PART_RANGES[partNumber]!;
  const perGroup = range.perGroup ?? 3;
  const transcripts = new Map<number, string>();
  let searchFrom = 0;

  for (let gs = range.start; gs <= range.end; gs += perGroup) {
    const ge = Math.min(gs + perGroup - 1, range.end);
    const slice = sectionText.slice(searchFrom);
    let localStart = -1;

    const rangeMarker = new RegExp(`(?:^|\\n)\\s*${gs}\\s*-\\s*${ge}\\b`, "m");
    const rangeMatch = rangeMarker.exec(slice);
    if (rangeMatch) {
      localStart = rangeMatch.index;
    } else {
      const embeddedSpeaker = new RegExp(
        `(?:^|\\n)\\s*[WM]\\s*[-–]?\\s*[A-Za-z]{2,4}[^\\n]*?\\b${gs}\\s*(?=['"A-Za-z(])`,
        "im"
      );
      const embeddedMatch = embeddedSpeaker.exec(slice);
      if (embeddedMatch) {
        localStart = embeddedMatch.index;
      } else {
        const nextSpeaker = /(?:^|\n)\s*[WM]\s*[-–]?\s*[A-Za-z]{2,4}\b/im;
        const speakerMatch = nextSpeaker.exec(slice);
        if (speakerMatch) localStart = speakerMatch.index;
      }
    }

    if (localStart < 0) continue;

    const absStart = searchFrom + localStart;
    const chunkSlice = sectionText.slice(absStart);
    const endIdx = chunkSlice.search(
      new RegExp(
        `(?:^|\\n)\\s*${gs}\\s*\\n\\s*(?:What|Where|Who|How|Which|According|Look at|Why|When)`,
        "im"
      )
    );
    const chunk = endIdx > 20 ? chunkSlice.slice(0, endIdx) : chunkSlice.slice(0, 2800);
    const text = cleanTranscriptText(chunk);
    if (text.length > 40) {
      transcripts.set(gs, text);
      searchFrom = absStart + Math.max(chunk.length, 80);
    }
  }

  return transcripts;
}

function parseListeningKeySection(
  sectionText: string,
  partNumber: 1 | 2 | 3 | 4,
  lcKeyText: string
): RawToeicGroup[] {
  const range = PART_RANGES[partNumber]!;
  const groups: RawToeicGroup[] = [];
  const keyAnswers = parseListeningKeyAnswers(lcKeyText, range.start, range.end);

  if (partNumber === 1) {
    const photoSets = extractPart1PhotoOptionSets(lcKeyText);
    const assigned = assignPart1SetsToQuestions(photoSets, keyAnswers, lcKeyText);

    for (let q = range.start; q <= range.end; q++) {
      const set = assigned.get(q);
      const options = set
        ? [set.A, set.B, set.C, set.D]
        : ["-", "-", "-", "-"];

      groups.push({
        sourcePage: undefined,
        questions: [{
          questionNumber: q,
          questionText: "What is the best description of the photograph?",
          options: padOptions(options, 4),
          correctAnswer: keyAnswers[q],
        }],
      });
    }
    return groups;
  }

  const transcriptMap =
    partNumber >= 3
      ? extractConversationTranscripts(sectionText, partNumber as 3 | 4)
      : new Map<number, string>();

  for (let q = range.start; q <= range.end; q++) {
    const nextQ = q < range.end ? q + 1 : q + 1;
    const block = extractQuestionBlock(sectionText, q, nextQ, q === range.end);
    const questionText =
      partNumber === 2
        ? extractPart2QuestionText(block, q)
        : extractPart34QuestionText(block, q);
    const options = extractOptionsFromSection(block);
    const perGroup = range.perGroup ?? 1;

    if (partNumber >= 3) {
      const groupIdx = Math.floor((q - range.start) / (perGroup || 1));
      const groupStart = range.start + groupIdx * (perGroup || 1);
      if (!groups[groupIdx]) {
        groups[groupIdx] = {
          transcript: transcriptMap.get(groupStart) ?? "",
          questions: [],
        };
      }
      groups[groupIdx]!.questions.push({
        questionNumber: q,
        questionText,
        options: padOptions(options, partNumber === 2 ? 3 : 4),
        correctAnswer: keyAnswers[q],
      });
    } else {
      groups.push({
        questions: [{
          questionNumber: q,
          questionText,
          options: padOptions(options, partNumber === 2 ? 3 : 4),
          correctAnswer: keyAnswers[q],
        }],
      });
    }
  }

  return groups.filter((g) => g.questions.length > 0);
}

function extractOptionsFromSection(block: string): string[] {
  const options: string[] = [];
  for (const line of block.split("\n")) {
    const normalized = normalizeOptionLine(line);
    const m = normalized.match(OPTION_LINE_RE);
    if (m) {
      options.push(m[2]!.trim());
      continue;
    }
    // KEY LC often embeds options on speaker lines: "W-Arn (A) The fifth."
    for (const em of normalized.matchAll(/\(([A-D])\)\s*([^(\n]+?)(?=\s*\([A-D]\)|$)/gi)) {
      const idx = em[1]!.toUpperCase().charCodeAt(0) - 65;
      const text = em[2]!.trim();
      if (idx < 0 || idx > 3 || !text) continue;
      while (options.length <= idx) options.push("");
      if (!options[idx]) options[idx] = text;
    }
  }
  return options.filter(Boolean);
}

function extractPart34QuestionText(block: string, q: number): string {
  const questionLines: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isAnswerKeyLine(line)) continue;
    if (OPTION_LINE_RE.test(normalizeOptionLine(line))) break;
    if (/^\([A-D]\)/i.test(line)) break;
    if (/\([A-D]\)\s*[^(\n]+/i.test(line)) break;
    if (/^(?:W|M)\s*[-–]/i.test(line)) continue;

    questionLines.push(line);
  }

  const questionText = questionLines
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return questionText || `Question ${q}`;
}

function extractQuestionBlock(sectionText: string, q: number, nextQ: number, isLastInSection: boolean): string {
  const boundary = String.raw`(?:^|\n)\s*${q}\s*(?:[\.\):]|\s*\n)`;
  if (isLastInSection) {
    const re = new RegExp(`${boundary}([\\s\\S]*)`, "im");
    return sectionText.match(re)?.[1] ?? "";
  }
  const nextBoundary = String.raw`(?:^|\n)\s*${nextQ}\s*(?:[\.\):]|\s*\n)`;
  const re = new RegExp(`${boundary}([\\s\\S]*?)(?=${nextBoundary})`, "im");
  return sectionText.match(re)?.[1] ?? "";
}

function extractPart2QuestionText(block: string, q: number): string {
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !OPTION_LINE_RE.test(normalizeOptionLine(l)))
    .filter((l) => !/^\([A-D]\)/i.test(l))
    .filter((l) => !LC_ANSWER_KEY_LINE_RE.test(l));

  const dialogue = lines.find((l) => /^(?:W|M)\s*[-–]/i.test(l) && !/\([A-D]\)/i.test(l));
  if (dialogue) return dialogue.replace(/^(?:W|M)\s*[-–]?\s*[A-Za-z]{2,4}\s*/i, "").trim();

  const prompt = lines.find((l) => /\?/.test(l) && !/[\u0080-\uFFFF]{4,}/.test(l));
  if (prompt) return prompt.replace(/^(?:W|M)\s*[-–]?\s*[A-Za-z]{2,4}\s*/i, "").trim();

  return lines[0]?.replace(/^(?:W|M)\s*[-–]?\s*[A-Za-z]{2,4}\s*/i, "").trim() || `Question ${q}`;
}

function padOptions(options: string[], count: number): string[] {
  const out = [...options];
  while (out.length < count) out.push("-");
  return out.slice(0, count);
}

export function parseListeningParts(keyLcText: string, _examText: string): RawToeicPart[] {
  const sections = splitByPartHeaders(keyLcText);
  const parts: RawToeicPart[] = [];

  for (const partNumber of [1, 2, 3, 4] as const) {
    const section = sections.get(partNumber) ?? keyLcText;
    parts.push({
      partNumber,
      groups: parseListeningKeySection(section, partNumber, keyLcText),
    });
  }

  return parts;
}

/** @internal exported for unit tests */
export const part1ParserInternals = {
  extractPart1PhotoOptionSets,
  assignPart1SetsToQuestions,
  isPhotoStatement,
};
