import { GoogleGenAI, Type } from "@google/genai";

let aiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required for OCR parsing.");
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

export interface ParsedQuestion {
  questionNumber: number;
  passage?: string;
  questionText: string;
  options: { letter: string; text: string }[];
  correctAnswer: string; // "A", "B", "C", "D"
  transcript?: string;
}

export interface ParsedExamData {
  partNumber: number;
  questions: ParsedQuestion[];
}

export async function parseToeicContent(
  ocrText: string,
  imageBufferBase64?: { data: string; mimeType: string }
): Promise<ParsedExamData> {
  const client = getAiClient();

  const prompt = `
You are an exam content parser specialized ONLY in TOEIC exams.

Input:
- Raw OCR text extracted from image or PDF.
${ocrText ? `- Raw OCR Text: "${ocrText}"` : ""}
- The text may contain noise, OCR mistakes, or broken formatting.

Your tasks:
1. Detect TOEIC part number (1–7).
2. For each question:
   - Extract exact question text.
   - Extract all answer options (A, B, C, D).
   - Detect correct answer if explicitly present (or fallback to 'A' if not detectable).
3. DO NOT add explanations or meanings.
4. Preserve original wording as close as possible.
5. Normalize spacing, punctuation, and obvious OCR mistakes.
6. Output strictly valid JSON.

Rules:
- Do NOT invent missing text.
- If uncertain, still output best guess.
- Accuracy is more important than completeness.
`;

  try {
    let contents: any = prompt;

    if (imageBufferBase64) {
      contents = {
        parts: [
          {
            inlineData: {
              data: imageBufferBase64.data,
              mimeType: imageBufferBase64.mimeType,
            },
          },
          {
            text: prompt,
          },
        ],
      };
    }

    const response = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            partNumber: {
              type: Type.INTEGER,
              description: "Detect details of TOEIC Part Number (1–7)"
            },
            questions: {
              type: Type.ARRAY,
              description: "Extracted TOEIC questions list",
              items: {
                type: Type.OBJECT,
                properties: {
                  questionNumber: {
                    type: Type.INTEGER,
                    description: "The TOEIC question number"
                  },
                  passage: {
                    type: Type.STRING,
                    description: "Optionally extract passage, long read or reading text context (e.g. for Part 6 or 7)"
                  },
                  questionText: {
                    type: Type.STRING,
                    description: "The core question or prompt text"
                  },
                  options: {
                    type: Type.ARRAY,
                    description: "List of A, B, C, D text options",
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        letter: { type: Type.STRING, description: "Letter option A, B, C or D" },
                        text: { type: Type.STRING, description: "Option answer text" }
                      },
                      required: ["letter", "text"]
                    }
                  },
                  correctAnswer: {
                    type: Type.STRING,
                    description: "The correct answer selected ('A', 'B', 'C', 'D')"
                  },
                  transcript: {
                    type: Type.STRING,
                    description: "Script transcript (if part 1-4 Listening, e.g. monologue or dialogue script)"
                  }
                },
                required: ["questionNumber", "questionText", "options", "correctAnswer"]
              }
            }
          },
          required: ["partNumber", "questions"]
        }
      }
    });

    const parsedJson = JSON.parse(response.text || "{}");
    return parsedJson as ParsedExamData;
  } catch (error) {
    console.error("Gemini AI Parsing Error:", error);
    throw new Error(`AI parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
