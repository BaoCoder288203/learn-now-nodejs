import type {
  NormalizedBbox,
  ParsedGroup,
  ParsedOption,
  ParsedPart,
  ParsedQuestion,
} from "./ai/types.js";

const MIN_BBOX_DIM = 0.02;

function coerceImageBbox(raw: unknown): NormalizedBbox | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const nums = raw.map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  let [x, y, w, h] = nums as NormalizedBbox;
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  w = Math.max(0, Math.min(1 - x, w));
  h = Math.max(0, Math.min(1 - y, h));
  if (w < MIN_BBOX_DIM || h < MIN_BBOX_DIM) return undefined;
  return [x, y, w, h];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isQuestionLike(value: unknown): boolean {
  const rec = asRecord(value);
  if (!rec) return false;
  return (
    "questionNumber" in rec ||
    "questionText" in rec ||
    "options" in rec ||
    "correctAnswer" in rec
  );
}

const OPTION_LETTERS = ["A", "B", "C", "D", "E"] as const;

const PART_FIRST_QUESTION: Record<number, number> = {
  1: 1,
  2: 7,
  3: 32,
  4: 71,
  5: 101,
  6: 131,
  7: 147,
};

function normalizeOption(raw: unknown, fallbackLetter = "A"): ParsedOption | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const prefixed = trimmed.match(/^([A-E])\)\s*(.+)$/i);
    if (prefixed) {
      return {
        letter: prefixed[1]!.toUpperCase(),
        text: prefixed[2]!.trim(),
      };
    }
    return { letter: fallbackLetter, text: trimmed };
  }

  const rec = asRecord(raw);
  if (!rec) return null;
  const letter = String(rec.letter ?? rec.option ?? fallbackLetter)
    .trim()
    .toUpperCase()
    .slice(0, 1);
  const text = String(rec.text ?? rec.optionText ?? rec.content ?? "").trim();
  if (!text) return null;
  return { letter: letter || fallbackLetter, text };
}

function parseOptionsFromLabelString(raw: string): ParsedOption[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const matches = [...trimmed.matchAll(/\(([A-E])\)\s*([\s\S]*?)(?=\s*\([A-E]\)|$)/gi)];
  if (matches.length >= 2) {
    return matches
      .map((m) => normalizeOption({ letter: m[1], text: m[2]!.trim() }))
      .filter((o): o is ParsedOption => o !== null);
  }

  return normalizeOption(trimmed) ? [normalizeOption(trimmed)!] : [];
}

function normalizeOptionsFromRaw(rawOptions: unknown): ParsedOption[] {
  if (typeof rawOptions === "string") {
    return parseOptionsFromLabelString(rawOptions);
  }

  if (!Array.isArray(rawOptions)) {
    const optRec = asRecord(rawOptions);
    if (optRec) {
      return Object.entries(optRec)
        .map(([letter, text]) => normalizeOption({ letter, text: String(text) }, letter))
        .filter((o): o is ParsedOption => o !== null);
    }
    return [];
  }

  const result: ParsedOption[] = [];
  for (let i = 0; i < rawOptions.length; i++) {
    const letter = OPTION_LETTERS[i] ?? String.fromCharCode(65 + i);
    const opt = normalizeOption(rawOptions[i], letter);
    if (opt) result.push(opt);
  }
  return result;
}

function splitQuestionTextAndInlineOptions(combined: string): {
  questionText: string;
  options: ParsedOption[];
} {
  const trimmed = combined.trim();
  const firstOption = trimmed.search(/\s*\([A-E]\)\s+/i);
  if (firstOption < 0) {
    return { questionText: trimmed, options: [] };
  }
  const questionText = trimmed.slice(0, firstOption).trim();
  const options = parseOptionsFromLabelString(trimmed.slice(firstOption));
  return { questionText: questionText || trimmed, options };
}

function normalizeQuestion(raw: unknown): ParsedQuestion | null {
  const rec = asRecord(raw);
  if (!rec) return null;

  const questionNumberRaw = Number(rec.questionNumber ?? rec.number ?? rec.id);
  let questionText = String(rec.questionText ?? rec.text ?? rec.question ?? "").trim();
  const questionNumber =
    Number.isFinite(questionNumberRaw) && questionNumberRaw >= 1 ? questionNumberRaw : 0;

  let options = normalizeOptionsFromRaw(rec.options);
  if (!options.length && questionText) {
    const split = splitQuestionTextAndInlineOptions(questionText);
    if (split.options.length) {
      questionText = split.questionText;
      options = split.options;
    }
  }

  if (!questionText) {
    if (questionNumber >= 1) {
      questionText = `Câu ${questionNumber}`;
    } else {
      const preview = options[0]?.text;
      questionText = preview ? `Chọn đáp án phù hợp: ${preview.slice(0, 80)}` : "";
    }
  }
  if (!questionText) return null;

  const correctAnswer = String(rec.correctAnswer ?? rec.answer ?? "A")
    .trim()
    .toUpperCase()
    .slice(0, 1);

  return {
    questionNumber,
    questionText,
    options,
    correctAnswer: correctAnswer || "A",
  };
}

function coerceQuestionsArray(raw: unknown): ParsedQuestion[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map(normalizeQuestion).filter((q): q is ParsedQuestion => q !== null);
  }
  const rec = asRecord(raw);
  if (!rec) return [];
  if (isQuestionLike(rec)) {
    const one = normalizeQuestion(rec);
    return one ? [one] : [];
  }
  return Object.values(rec)
    .map(normalizeQuestion)
    .filter((q): q is ParsedQuestion => q !== null);
}

function normalizeGroup(raw: unknown, index: number): ParsedGroup {
  const rec = asRecord(raw);
  if (!rec) {
    console.warn(`[Normalize] group[${index}]: invalid, using empty questions`);
    return { questions: [] };
  }

  let questions = coerceQuestionsArray(rec.questions);

  if (!questions.length && isQuestionLike(rec)) {
    const one = normalizeQuestion(rec);
    if (one) questions = [one];
  }

  const passage = rec.passage != null ? String(rec.passage) : undefined;
  const transcript =
    rec.transcript != null
      ? String(rec.transcript)
      : rec.talk != null
        ? String(rec.talk)
        : undefined;
  const sourcePageRaw = rec.sourcePage ?? rec.page ?? rec.pageNumber;
  const sourcePage =
    sourcePageRaw != null && Number.isFinite(Number(sourcePageRaw))
      ? Number(sourcePageRaw)
      : undefined;

  const imageBbox = coerceImageBbox(
    rec.imageBbox ?? rec.passageBbox ?? rec.bbox ?? rec.cropBox
  );

  return {
    passage,
    transcript,
    sourcePage,
    imageBbox,
    questions,
  };
}

function groupsFromFlatQuestions(questions: ParsedQuestion[]): ParsedGroup[] {
  if (!questions.length) return [];
  return questions.map((q) => ({
    transcript: undefined,
    passage: undefined,
    questions: [q],
  }));
}

function assignSequentialQuestionNumbers(part: ParsedPart): ParsedPart {
  let next = PART_FIRST_QUESTION[part.partNumber] ?? 1;
  const groups = part.groups.map((group) => ({
    ...group,
    questions: group.questions.map((q) => {
      const existing = Number(q.questionNumber);
      let num: number;
      if (Number.isFinite(existing) && existing >= 1) {
        num = existing;
        next = Math.max(next, existing + 1);
      } else {
        num = next;
        next += 1;
      }
      return { ...q, questionNumber: num };
    }),
  }));
  return { partNumber: part.partNumber, groups };
}

/**
 * Coerce AI JSON variants into ParsedPart (groups[].questions[] always arrays).
 */
export function normalizeParsedPart(part: unknown, expectedPartNumber?: number): ParsedPart {
  const rec = asRecord(part);
  if (!rec) {
    throw new Error("Dữ liệu Part từ AI không phải object JSON.");
  }

  const partNumber = Number(rec.partNumber ?? expectedPartNumber);
  if (!Number.isFinite(partNumber) || partNumber < 1 || partNumber > 7) {
    throw new Error(`Part number không hợp lệ sau normalize: ${rec.partNumber}`);
  }

  let groups: ParsedGroup[] = [];

  const rawGroups = rec.groups ?? rec.group;
  if (Array.isArray(rawGroups)) {
    groups = rawGroups.map((g, i) => normalizeGroup(g, i));
  } else if (rawGroups) {
    groups = [normalizeGroup(rawGroups, 0)];
  }

  const flatQuestions = coerceQuestionsArray(rec.questions);
  if (flatQuestions.length) {
    if (!groups.length) {
      groups = groupsFromFlatQuestions(flatQuestions);
    } else {
      const emptyGroupIndexes = groups
        .map((g, i) => (!g.questions.length ? i : -1))
        .filter((i) => i >= 0);

      if (groups.every((g) => !g.questions.length)) {
        if (groups.length === 1) {
          groups = [{ ...groups[0]!, questions: flatQuestions }];
        } else {
          let offset = 0;
          groups = groups.map((g) => {
            const take = Math.max(1, Math.ceil(flatQuestions.length / groups.length));
            const slice = flatQuestions.slice(offset, offset + take);
            offset += take;
            return { ...g, questions: slice };
          });
        }
      } else if (emptyGroupIndexes.length === 1) {
        const idx = emptyGroupIndexes[0]!;
        groups[idx] = { ...groups[idx]!, questions: flatQuestions };
      }
    }
  }

  const emptyGroupCount = groups.filter((g) => !g.questions.length).length;
  if (emptyGroupCount > 0) {
    console.warn(
      `[Normalize] Part ${partNumber}: ${emptyGroupCount}/${groups.length} group(s) không có questions[]`
    );
  }

  let normalized = assignSequentialQuestionNumbers({ partNumber, groups });

  if (partNumber === 7) {
    normalized = consolidatePart7(normalized);
  }

  return normalized;
}

/** Drop duplicate questionNumbers and out-of-range rows from chunked Part 7 parses. */
function consolidatePart7(part: ParsedPart): ParsedPart {
  const seen = new Set<number>();
  const groups: ParsedGroup[] = [];

  for (const group of part.groups) {
    const questions = group.questions.filter((q) => {
      if (q.questionNumber < 147 || q.questionNumber > 200) return false;
      if (seen.has(q.questionNumber)) return false;
      seen.add(q.questionNumber);
      return true;
    });
    if (questions.length) {
      groups.push({ ...group, questions });
    }
  }

  return { partNumber: 7, groups };
}

export function normalizeParsedParts(parts: ParsedPart[]): ParsedPart[] {
  return parts.map((p) => normalizeParsedPart(p, p.partNumber));
}
