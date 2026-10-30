import { handle, json } from "@/lib/http";
import {
  authenticateScannerRequest,
  readScannerUpload,
  importScannerFile,
} from "@/lib/services/scanner-import";

export async function POST(request: Request) {
  return handle(async () => {
    const identity = await authenticateScannerRequest(request);
    const result = await importScannerFile(
      identity,
      await readScannerUpload(request),
    );
    return json(result.receipt, result.created ? 201 : 200);
  });
}
