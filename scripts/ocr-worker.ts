import { setTimeout } from "node:timers/promises";
import { db } from "../src/lib/db";
import { processOcrQueue } from "../src/lib/services/ocr";

const once = process.argv.includes("--once");
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
try {
  do {
    const result = await processOcrQueue(5);
    console.log(JSON.stringify({ worker: "ocr", processed: result.processed }));
    if (!once && !stopping) await setTimeout(5000);
  } while (!once && !stopping);
} catch (error) {
  console.error(
    "OCR worker stopped:",
    error instanceof Error ? error.constructor.name : "UnknownError",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
