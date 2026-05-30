export type CanonicalFileRole =
  | "EXAM_DOC"
  | "LISTENING_KEY_DOC"
  | "READING_KEY_IMAGE"
  | "AUDIO_FILE"
  | "UNKNOWN";

export interface CanonicalFile {
  name: string;
  mimeType: string;
  storageKey: string;
  text: string;
  role: CanonicalFileRole;
  confidence: number;
}

export interface CanonicalDocumentPayload {
  files: CanonicalFile[];
  confidence: number;
  needsReview: boolean;
  suggestions: Array<{
    fileName: string;
    suggestedRole: CanonicalFileRole;
    confidence: number;
    reason: string;
  }>;
}

function computeRole(name: string, mimeType: string, text: string): {
  role: CanonicalFileRole;
  confidence: number;
  reason: string;
} {
  const n = name.toLowerCase();
  const t = text.toLowerCase();

  if (mimeType.startsWith("audio/") || n.endsWith(".mp3")) {
    return { role: "AUDIO_FILE", confidence: 1, reason: "Detected audio MIME/extension" };
  }

  const examSignals = ["part 5", "part 6", "part 7", "incomplete sentences", "reading"];
  const listeningSignals = ["transcript", "part 1", "part 2", "part 3", "part 4", "listening"];
  const keySignals = ["answer key", "101", "200", "a b c d"];

  if (n.includes("key rc") || n.includes("reading key")) {
    return { role: "READING_KEY_IMAGE", confidence: 0.92, reason: "Filename suggests RC answer key" };
  }
  if (n.includes("key lc") || n.includes("transcript")) {
    return { role: "LISTENING_KEY_DOC", confidence: 0.92, reason: "Filename suggests LC key/transcript" };
  }
  if (examSignals.some((s) => t.includes(s))) {
    return { role: "EXAM_DOC", confidence: 0.82, reason: "Content resembles reading exam sections" };
  }
  if (listeningSignals.some((s) => t.includes(s))) {
    return { role: "LISTENING_KEY_DOC", confidence: 0.78, reason: "Content resembles listening transcript/key" };
  }
  if (keySignals.some((s) => t.includes(s))) {
    return { role: "READING_KEY_IMAGE", confidence: 0.7, reason: "Content resembles answer-key grid" };
  }

  return { role: "UNKNOWN", confidence: 0.35, reason: "No clear TOEIC signature" };
}

export function buildCanonicalPayload(
  files: Array<{
    name: string;
    mimeType: string;
    storageKey: string;
    text: string;
  }>,
  threshold = 0.9
): CanonicalDocumentPayload {
  const canonicalFiles: CanonicalFile[] = [];
  const suggestions: CanonicalDocumentPayload["suggestions"] = [];

  for (const file of files) {
    const roleDecision = computeRole(file.name, file.mimeType, file.text);
    canonicalFiles.push({
      name: file.name,
      mimeType: file.mimeType,
      storageKey: file.storageKey,
      text: file.text,
      role: roleDecision.role,
      confidence: roleDecision.confidence,
    });
    suggestions.push({
      fileName: file.name,
      suggestedRole: roleDecision.role,
      confidence: roleDecision.confidence,
      reason: roleDecision.reason,
    });
  }

  const confidence =
    canonicalFiles.reduce((sum, f) => sum + f.confidence, 0) /
    Math.max(canonicalFiles.length, 1);

  const requiredRoles: CanonicalFileRole[] = [
    "EXAM_DOC",
    "LISTENING_KEY_DOC",
    "READING_KEY_IMAGE",
  ];
  const hasAllRequired = requiredRoles.every((r) =>
    canonicalFiles.some((f) => f.role === r)
  );
  const hasUnknown = canonicalFiles.some((f) => f.role === "UNKNOWN");

  return {
    files: canonicalFiles,
    confidence,
    needsReview: confidence < threshold || !hasAllRequired || hasUnknown,
    suggestions,
  };
}
