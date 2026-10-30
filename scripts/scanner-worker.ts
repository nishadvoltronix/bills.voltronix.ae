import { setTimeout } from "node:timers/promises";
import {
  createDiskScanner, createScannerTransport, openScannerState,
  parseScannerConfig, ScannerError, ScannerWorker,
  type ScannerStateStore,
} from "./lib/scanner-worker";

const options = process.argv.slice(2);
let state: ScannerStateStore | undefined;
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
try {
  if (new Set(options).size !== options.length || options.some((value) => !["--once", "--include-existing"].includes(value)))
    throw new ScannerError("CONFIGURATION_INVALID");
  const config = parseScannerConfig(process.env);
  state = await openScannerState(config);
  const worker = new ScannerWorker(config, createDiskScanner(config), createScannerTransport(config), state, {
    includeExisting: options.includes("--include-existing"),
  });
  do {
    const report = await worker.tick();
    console.log(JSON.stringify({ worker: "scanner", ...report }));
    if (options.includes("--once") || stopping) break;
    await setTimeout(config.pollMs);
  } while (!stopping);
} catch (error) {
  console.error(JSON.stringify({ worker: "scanner", code: error instanceof ScannerError ? error.code : "WORKER_FAILED" }));
  process.exitCode = 1;
} finally { await state?.close?.(); }
