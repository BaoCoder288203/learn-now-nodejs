import "dotenv/config";
import express from "express";
import cors from "cors";
import apiRouter from "./routes/api.js";
import { seedDatabaseIfEmpty } from "./seed.js";

function parseCorsOrigins(): string | string[] {
  const raw = process.env.CORS_ORIGIN;
  if (!raw) {
    return ["http://localhost:5173", "http://localhost:3000"];
  }
  const origins = raw.split(",").map((o) => o.trim()).filter(Boolean);
  return origins.length === 1 ? origins[0]! : origins;
}

async function startApiServer(): Promise<void> {
  const app = express();
  const PORT = Number(process.env.PORT) || 4000;

  app.use(
    cors({
      origin: parseCorsOrigins(),
      credentials: true,
    })
  );
  app.use(express.json({ limit: "20mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api", apiRouter);

  await seedDatabaseIfEmpty();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`TOEIC API running on http://localhost:${PORT}`);
  });
}

startApiServer().catch((err) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
