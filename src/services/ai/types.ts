export interface ParsedOption {
  letter: string;
  text: string;
}

export interface ParsedQuestion {
  questionNumber: number;
  questionText: string;
  options: ParsedOption[];
  correctAnswer: string;
}

/** Normalized [x, y, w, h] on sourcePage (0–1). Used for PDF crop at import. */
export type NormalizedBbox = [number, number, number, number];

export interface ParsedGroup {
  passage?: string;
  transcript?: string;
  imageDescription?: string;
  sourcePage?: number;
  sourcePages?: number[];
  /** Crop rectangle on sourcePage for Part 1 photo or Part 6/7 passage block. */
  imageBbox?: NormalizedBbox;
  questions: ParsedQuestion[];
}

export interface TextRegion {
  id: string;
  text: string;
  bbox: [number, number, number, number];
}

export interface ParsedPart {
  partNumber: number;
  groups: ParsedGroup[];
}

export interface FileRolePrediction {
  fileName: string;
  role: "EXAM_DOC" | "LISTENING_KEY_DOC" | "READING_KEY_IMAGE" | "AUDIO_FILE" | "UNKNOWN";
  confidence: number;
  reason: string;
}

export interface RcAnswerMap {
  [questionNumber: string]: string;
}

export interface PdfInlineData {
  data: string;
  mimeType: string;
}

export interface ParsedExamData {
  partNumber: number;
  questions: {
    questionNumber: number;
    passage?: string;
    questionText: string;
    options: { letter: string; text: string }[];
    correctAnswer: string;
    transcript?: string;
  }[];
}

export type AiProviderName = "alibaba" | "openai" | "deepseek" | "gemini";
