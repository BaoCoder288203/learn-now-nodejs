import { Response } from "express";
import { prisma } from "../db.js";
import { AuthenticatedRequest } from "../middlewares/authMiddleware.js";

// Fetch whole user vocabulary list
export async function getVocabList(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const vocab = await prisma.userVocabulary.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" }
    });

    res.json(vocab);
  } catch (error) {
    console.error("Get vocab list error:", error);
    res.status(500).json({ error: "Failed to load vocabulary list" });
  }
}

// Convert/Save SelectedWord word into vocabulary notebook
export async function saveVocabWord(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { word, sentenceContext, partNumber, status } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!word) {
    res.status(400).json({ error: "Word is required." });
    return;
  }

  try {
    // Check if vocabulary entry already exists
    const existing = await prisma.userVocabulary.findUnique({
      where: {
        userId_word: {
          userId,
          word: word.trim(),
        }
      }
    });

    let vocabItem;
    if (existing) {
      // Update existing item if saved again
      vocabItem = await prisma.userVocabulary.update({
        where: { id: existing.id },
        data: {
          sentenceContext: sentenceContext || existing.sentenceContext,
          partNumber: partNumber || existing.partNumber,
          status: status || existing.status
        }
      });
    } else {
      // Create new vocabulary entry
      vocabItem = await prisma.userVocabulary.create({
        data: {
          userId,
          word: word.trim(),
          sentenceContext: sentenceContext || "",
          partNumber: partNumber || null,
          status: status || "new"
        }
      });
    }

    res.status(201).json({ message: "Word added/updated under vocabulary list", vocab: vocabItem });
  } catch (error) {
    console.error("Save vocabulary error:", error);
    res.status(500).json({ error: "Failed to save word" });
  }
}

// Update vocabulary status directly
export async function updateVocabStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { vocabId } = req.params;
  const { status } = req.body; // "new", "learning", "mastered"
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!status || !["new", "learning", "mastered"].includes(status)) {
    res.status(400).json({ error: "Invalid status value. Must be 'new', 'learning', or 'mastered'." });
    return;
  }

  try {
    const original = await prisma.userVocabulary.findUnique({ where: { id: vocabId } });
    if (!original || original.userId !== userId) {
      res.status(404).json({ error: "Vocabulary word not found or access denied." });
      return;
    }

    const updated = await prisma.userVocabulary.update({
      where: { id: vocabId },
      data: { status }
    });

    res.json({ message: "Vocabulary status updated successfully.", vocab: updated });
  } catch (error) {
    console.error("Update vocab status error:", error);
    res.status(500).json({ error: "Failed to update status." });
  }
}

// Delete vocabulary word from lists
export async function deleteVocabWord(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { vocabId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const original = await prisma.userVocabulary.findUnique({ where: { id: vocabId } });
    if (!original || original.userId !== userId) {
      res.status(404).json({ error: "Vocabulary item not found" });
      return;
    }

    await prisma.userVocabulary.delete({ where: { id: vocabId } });
    res.json({ message: "Word removed from vocabulary list." });
  } catch (error) {
    console.error("Delete vocab error:", error);
    res.status(500).json({ error: "Failed to delete from notebook" });
  }
}
