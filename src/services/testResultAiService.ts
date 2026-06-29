import { generateJsonWithDualProviders } from "./ai/dualProvider.js";
import { safeParseJson } from "./ai/jsonUtils.js";
import { openaiChatJson } from "./ai/openaiProvider.js";
import { getGeminiClient } from "./ai/geminiProvider.js";

const MAX_WORDS_PER_BATCH = 30;
const MAX_WRONG_ANSWERS_PER_BATCH = 30;

export interface SelectedWordInput {
  id: string;
  word: string;
  sentenceContext: string;
  partNumber: number;
}

export interface SelectedWordAiResult {
  meaningVi: string;
  example: string;
  synonyms: string[];
}

export interface WrongAnswerInput {
  id: string;
  partNumber: number;
  questionText: string;
  passage?: string | null;
  transcript?: string | null;
  selectedOption: string;
  selectedOptionText: string;
  correctAnswer: string;
  correctOptionText: string;
  options: Array<{ letter: string; text: string }>;
}

export interface WrongAnswerAiResult {
  explanationVi: string;
}

const WORD_ENRICH_SCHEMA = {
  name: "word_enrichment",
  schema: {
    type: "object",
    properties: {
      meaningVi: { type: "string", description: "Vietnamese meaning of the word" },
      example: { type: "string", description: "Practical example sentence in English" },
      synonyms: {
        type: "array",
        items: { type: "string" },
        description: "3-5 English synonyms",
      },
    },
    required: ["meaningVi", "example", "synonyms"],
    additionalProperties: false,
  },
};

const WRONG_ANSWER_SCHEMA = {
  name: "wrong_answer_explanation",
  schema: {
    type: "object",
    properties: {
      explanationVi: {
        type: "string",
        description: "Vietnamese explanation why user choice is wrong and correct answer is right",
      },
    },
    required: ["explanationVi"],
    additionalProperties: false,
  },
};

async function callAiJson<T>(
  label: string,
  prompt: string,
  schema: { name: string; schema: Record<string, unknown> }
): Promise<T> {
  const messages = [{ role: "user" as const, content: prompt }];

  return generateJsonWithDualProviders(
    label,
    {
      openai: (model) => openaiChatJson(model, messages, schema, label),
      gemini: (model) =>
        getGeminiClient().models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: 2048,
          },
        }),
    },
    (text) => safeParseJson<T>(text, label)
  );
}

export async function enrichSelectedWord(
  input: SelectedWordInput
): Promise<SelectedWordAiResult> {
  const prompt = `You are a TOEIC vocabulary tutor. Analyze this word selected by a student during a TOEIC practice test.

Word: "${input.word}"
Context sentence: "${input.sentenceContext}"
TOEIC Part: ${input.partNumber}

Return JSON with:
- meaningVi: clear Vietnamese meaning suitable for Vietnamese learners
- example: one practical real-world example sentence in English (different from context if possible)
- synonyms: array of 3-5 common English synonyms (single words or short phrases)

Keep explanations concise and appropriate for TOEIC level.`;

  return callAiJson<SelectedWordAiResult>("enrich_selected_word", prompt, WORD_ENRICH_SCHEMA);
}

export async function explainWrongAnswer(
  input: WrongAnswerInput
): Promise<WrongAnswerAiResult> {
  const optionsText = input.options
    .map((o) => `${o.letter}. ${o.text}`)
    .join("\n");

  const contextBlock = [
    input.passage ? `Passage:\n${input.passage}` : "",
    input.transcript ? `Transcript:\n${input.transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = `You are a TOEIC tutor explaining why a student's answer was wrong.

TOEIC Part: ${input.partNumber}
Question: ${input.questionText}
${contextBlock ? `\n${contextBlock}\n` : ""}
Options:
${optionsText}

Student selected: ${input.selectedOption}. ${input.selectedOptionText}
Correct answer: ${input.correctAnswer}. ${input.correctOptionText}

Write explanationVi in Vietnamese:
1. Why the student's choice (${input.selectedOption}) is incorrect in this TOEIC context
2. Why the correct answer (${input.correctAnswer}) is the best choice
3. Brief grammar/vocabulary tip if relevant

Be specific to this question context. 3-5 sentences max.`;

  return callAiJson<WrongAnswerAiResult>(
    "explain_wrong_answer",
    prompt,
    WRONG_ANSWER_SCHEMA
  );
}

export async function enrichSelectedWordsBatch(
  words: SelectedWordInput[]
): Promise<Map<string, SelectedWordAiResult>> {
  const results = new Map<string, SelectedWordAiResult>();
  const batch = words.slice(0, MAX_WORDS_PER_BATCH);

  const deduped = new Map<string, SelectedWordInput>();
  for (const w of batch) {
    const key = w.word.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, w);
  }

  for (const [, wordInput] of deduped) {
    try {
      const result = await enrichSelectedWord(wordInput);
      results.set(wordInput.word.toLowerCase(), result);
    } catch (err) {
      console.error(`[testResultAi] Failed to enrich word "${wordInput.word}":`, err);
    }
  }

  return results;
}

export async function explainWrongAnswersBatch(
  answers: WrongAnswerInput[]
): Promise<Map<string, WrongAnswerAiResult>> {
  const results = new Map<string, WrongAnswerAiResult>();
  const batch = answers.slice(0, MAX_WRONG_ANSWERS_PER_BATCH);

  for (const ans of batch) {
    try {
      const result = await explainWrongAnswer(ans);
      results.set(ans.id, result);
    } catch (err) {
      console.error(`[testResultAi] Failed to explain answer ${ans.id}:`, err);
    }
  }

  return results;
}

export { MAX_WORDS_PER_BATCH, MAX_WRONG_ANSWERS_PER_BATCH };
