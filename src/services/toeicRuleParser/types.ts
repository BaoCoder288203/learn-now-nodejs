import type { NormalizedBbox } from "../ai/types.js";
import type { PyMuPdfDocumentLayout } from "../pymupdfClient.js";
import type { RcAnswerMap } from "../toeicAiService.js";

export interface RawToeicQuestion {
  questionNumber: number;
  questionText: string;
  options: string[];
  correctAnswer?: string;
}

export interface RawToeicGroup {
  passage?: string;
  transcript?: string;
  sourcePage?: number;
  imageBbox?: NormalizedBbox;
  questions: RawToeicQuestion[];
}

export interface RawToeicPart {
  partNumber: number;
  groups: RawToeicGroup[];
}

export interface RawToeicDocument {
  parts: RawToeicPart[];
}

export interface ToeicParserInput {
  examLayout: PyMuPdfDocumentLayout;
  examText: string;
  keyLcText: string;
  rcAnswers: RcAnswerMap;
}

export interface PyMuPdfExtractResult {
  examText: string;
  examLayout: PyMuPdfDocumentLayout;
  keyLcText: string;
  examTextLength: number;
  transcriptTextLength: number;
}
