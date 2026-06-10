/** JSON Schema for OpenAI structured outputs + documentation for Gemini. */
export const SINGLE_PART_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    partNumber: { type: "integer" },
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          passage: { type: "string" },
          transcript: { type: "string" },
          sourcePage: { type: "integer" },
          imageBbox: {
            type: "array",
            items: { type: "number" },
            minItems: 4,
            maxItems: 4,
          },
          questions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                questionNumber: { type: "integer" },
                questionText: { type: "string" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      letter: { type: "string" },
                      text: { type: "string" },
                    },
                    required: ["letter", "text"],
                  },
                },
                correctAnswer: { type: "string" },
              },
              required: ["questionNumber", "questionText", "options", "correctAnswer"],
            },
          },
        },
        required: ["questions"],
      },
    },
  },
  required: ["partNumber", "groups"],
} as const;

export const IMAGE_BBOX_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    imageBbox: {
      type: "array",
      items: { type: "number" },
      minItems: 4,
      maxItems: 4,
    },
  },
  required: ["imageBbox"],
} as const;

export const TEXT_REGIONS_JSON_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      bbox: {
        type: "array",
        items: { type: "number" },
        minItems: 4,
        maxItems: 4,
      },
    },
    required: ["id", "text", "bbox"],
  },
} as const;

export const FILE_ROLE_JSON_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      fileName: { type: "string" },
      role: { type: "string" },
      confidence: { type: "number" },
      reason: { type: "string" },
    },
    required: ["fileName", "role", "confidence", "reason"],
  },
} as const;
