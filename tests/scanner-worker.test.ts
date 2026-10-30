import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, open, readFile, writeFile, symlink, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createDiskScanner, createScannerTransport, holdWindowsFileLock,
  MAX_SCANNER_BYTES, openScannerState, parseScannerConfig, ScannerError,
  ScannerWorker, type ScannerConfig, type ScannerDisk, type ScannerEntry,
  type ScannerState, type ScannerStateStore, type ScannerTransport,
} from "../scripts/lib/scanner-worker";

const pdf = Buffer.from("%PDF-1.4\n1 0 obj <</Type/Catalog>> endobj\n%%EOF\n");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const binding = digest("test-source");
const accepted = { importId: "test-import", status: "IMPORTED" as const, duplicate: false };
function entry(name = "invoice.pdf", version = "1", size = pdf.length): ScannerEntry {
  return { name, fingerprint: digest(`${name}:${version}`), size };
}
function harness(options: { includeExisting?: boolean } = {}) {
  let now = 1_000_000;
  let stored: ScannerState | null = null;
  let entries: ScannerEntry[] = [];
  const store: ScannerStateStore = {
    load: vi.fn(async () => stored ? structuredClone(stored) : null),
    save: vi.fn(async (state) => { stored = structuredClone(state); }),
  };
  const disk: ScannerDisk = { list: vi.fn(async () => entries), read: vi.fn(async () => pdf) };
  const transport = vi.fn<ScannerTransport>(async () => accepted);
  const make = () => new ScannerWorker({ binding, settleMs: 30_000 }, disk, transport, store, {
    ...options, now: () => now,
  });
  return {
    store, disk, transport, make, worker: make(),
    entries: (value: ScannerEntry[]) => { entries = value; },
    advance: (value = 30_000) => { now += value; },
    stored: () => structuredClone(stored),
    corruptBinding: () => { if (stored) stored.binding = digest("other-source"); },
  };
}

describe("scanner polling and durable handoff", () => {
  it("baselines existing PDFs without reading or uploading them by default", async () => {
    const h = harness(); h.entries([entry()]);
    expect(await h.worker.tick()).toMatchObject({ event: "baseline", baseline: 1 });
    h.advance(); await h.worker.tick();
    expect(h.disk.read).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
    expect(JSON.stringify(h.stored())).not.toContain("invoice.pdf");
  });

  it("requires two observations and the settling interval before opt-in existing import", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry()]);
    expect((await h.worker.tick()).waiting).toBe(1);
    h.advance(29_999); expect((await h.worker.tick()).waiting).toBe(1);
    h.advance(1); expect((await h.worker.tick()).submitted).toBe(1);
    expect(h.transport).toHaveBeenCalledWith(entry(), pdf, digest(pdf));
    h.advance(); await h.worker.tick();
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it("does not initialize the baseline while the network folder is disconnected", async () => {
    const h = harness(); h.entries([entry()]);
    vi.mocked(h.disk.list).mockRejectedValueOnce(new Error("private UNC must not appear"));
    const result = await h.worker.tick();
    expect(result).toMatchObject({ event: "network_retry", code: "NETWORK_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("UNC");
    expect(h.store.save).not.toHaveBeenCalled();
    h.advance(5_000);
    expect(await h.worker.tick()).toMatchObject({ event: "baseline", baseline: 1 });
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("uses exponential backoff during network outages", async () => {
    const h = harness(); vi.mocked(h.disk.list).mockRejectedValue(new Error("offline"));
    await h.worker.tick();
    h.advance(4_999); expect((await h.worker.tick()).event).toBe("deferred");
    expect(h.disk.list).toHaveBeenCalledTimes(1);
    h.advance(1); await h.worker.tick();
    h.advance(9_999); expect((await h.worker.tick()).event).toBe("deferred");
    expect(h.disk.list).toHaveBeenCalledTimes(2);
  });

  it("resets settling whenever a copy changes size or timestamps", async () => {
    const h = harness(); await h.worker.tick();
    h.entries([entry("invoice.pdf", "partial", 20)]); await h.worker.tick();
    h.advance(); h.entries([entry("invoice.pdf", "complete")]);
    expect((await h.worker.tick()).waiting).toBe(1);
    expect(h.disk.read).not.toHaveBeenCalled();
    h.advance(); expect((await h.worker.tick()).submitted).toBe(1);
  });

  it("waits again when the file changes during snapshot reading", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry()]); await h.worker.tick(); h.advance();
    vi.mocked(h.disk.read).mockRejectedValueOnce(new ScannerError("FILE_CHANGED", true));
    expect((await h.worker.tick()).retrying).toBe(1);
    expect(h.transport).not.toHaveBeenCalled();
    h.advance(5_000); expect((await h.worker.tick()).waiting).toBe(1);
    h.advance(); expect((await h.worker.tick()).submitted).toBe(1);
  });

  it("does not import while a scanner still holds a write handle", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry()]); await h.worker.tick(); h.advance();
    vi.mocked(h.disk.read).mockRejectedValueOnce(new ScannerError("FILE_BUSY", true));
    expect((await h.worker.tick()).retrying).toBe(1);
    expect(h.transport).not.toHaveBeenCalled();
    h.advance(); expect((await h.worker.tick()).submitted).toBe(1);
  });

  it("withholds a truncated PDF and succeeds after the completed copy settles", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry()]); await h.worker.tick(); h.advance();
    vi.mocked(h.disk.read).mockResolvedValueOnce(Buffer.from("%PDF-1.4\nunfinished"));
    expect((await h.worker.tick()).retrying).toBe(1);
    expect(h.transport).not.toHaveBeenCalled();
    h.entries([entry("invoice.pdf", "complete")]); h.advance(); await h.worker.tick();
    h.advance(); expect((await h.worker.tick()).submitted).toBe(1);
  });

  it("refuses oversized files before allocating or reading their contents", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry("large.pdf", "1", MAX_SCANNER_BYTES + 1)]);
    await h.worker.tick(); h.advance();
    expect((await h.worker.tick()).failed).toBe(1);
    expect(h.disk.read).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("preserves newly observed pending files across worker restart instead of re-baselining", async () => {
    const h = harness(); await h.worker.tick(); h.entries([entry()]); await h.worker.tick();
    const restarted = h.make(); h.advance();
    expect((await restarted.tick()).submitted).toBe(1);
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost acknowledgement using the same hash and server deduplication", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry()]);
    const serverHashes = new Set<string>();
    h.transport.mockImplementation(async (_entry, _bytes, hash) => {
      if (serverHashes.has(hash)) return { ...accepted, status: "DUPLICATE", duplicate: true };
      serverHashes.add(hash); throw new ScannerError("IMPORT_RETRY", true);
    });
    await h.worker.tick(); h.advance(); expect((await h.worker.tick()).retrying).toBe(1);
    const restarted = h.make(); h.advance(4_999); expect((await restarted.tick()).waiting).toBe(1);
    h.advance(1); expect(await restarted.tick()).toMatchObject({ submitted: 1, duplicates: 1 });
    expect(serverHashes.size).toBe(1);
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it("sends identical files under different names with identical hashes for durable dedupe", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry("a.pdf"), entry("b.pdf")]);
    h.transport.mockResolvedValueOnce(accepted).mockResolvedValueOnce({ ...accepted, status: "DUPLICATE", duplicate: true });
    await h.worker.tick(); h.advance(); expect(await h.worker.tick()).toMatchObject({ submitted: 2, duplicates: 1 });
    expect(h.transport.mock.calls.map((call) => call[2])).toEqual([digest(pdf), digest(pdf)]);
  });

  it("keeps accepted Azure-not-configured handoffs submitted without repeat uploads", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry()]);
    await h.worker.tick(); h.advance(); await h.worker.tick();
    h.advance(); await h.make().tick();
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it("stops on authorization failure and retains pending work", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry()]);
    h.transport.mockRejectedValue(new ScannerError("AUTHORIZATION_FAILED"));
    await h.worker.tick(); h.advance();
    await expect(h.worker.tick()).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(Object.values(h.stored()!.files)[0]).toMatchObject({ status: "WAITING", code: "AUTHORIZATION_FAILED" });
  });

  it("refuses state belonging to a different folder, source or application", async () => {
    const h = harness(); await h.worker.tick(); h.corruptBinding();
    await expect(h.make().tick()).rejects.toMatchObject({ code: "STATE_INVALID" });
  });

  it("will not silently retroactively include a previously skipped baseline", async () => {
    const h = harness(); h.entries([entry()]); await h.worker.tick();
    const changed = new ScannerWorker({ binding, settleMs: 30_000 }, h.disk, h.transport, h.store, { includeExisting: true });
    await expect(changed.tick()).rejects.toMatchObject({ code: "STATE_INVALID" });
  });

  it("does not submit when the private journal cannot commit first-seen state", async () => {
    const h = harness({ includeExisting: true }); h.entries([entry()]);
    vi.mocked(h.store.save).mockRejectedValue(new ScannerError("STATE_UNAVAILABLE"));
    await expect(h.worker.tick()).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(h.transport).not.toHaveBeenCalled();
  });
});

const transportConfig = { apiOrigin: "https://billing.example.invalid", sourceId: "source-test", token: "a".repeat(64) };
describe("scanner scoped HTTP transport", () => {
  it("posts only the raw PDF using the agreed scoped headers, timeout and no redirects", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(accepted, { status: 201 }));
    expect(await createScannerTransport(transportConfig, request)(entry(), pdf, digest(pdf))).toEqual(accepted);
    const [url, options] = request.mock.calls[0];
    expect(String(url)).toBe("https://billing.example.invalid/api/scanner/imports");
    expect(options).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", headers: {
      "content-type": "application/pdf", "x-scanner-source": "source-test", "x-scanner-sha256": digest(pdf),
      "x-scanner-file-name": "invoice.pdf",
    } });
    expect(Buffer.from(options!.body as Uint8Array)).toEqual(pdf);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 403])("stops on HTTP %i without exposing the response body", async (status) => {
    const request = vi.fn<typeof fetch>(async () => new Response("private vendor and secret", { status }));
    await expect(createScannerTransport(transportConfig, request)(entry(), pdf, digest(pdf)))
      .rejects.toMatchObject({ message: "AUTHORIZATION_FAILED", retryable: false });
  });

  it.each([408, 409, 425, 429, 500, 502, 503])("retries HTTP %i without creating a second server identity", async (status) => {
    const request = vi.fn<typeof fetch>(async () => new Response("private", { status, headers: { "retry-after": "120" } }));
    await expect(createScannerTransport(transportConfig, request)(entry(), pdf, digest(pdf)))
      .rejects.toMatchObject({ code: "IMPORT_RETRY", retryable: true, retryAfterMs: 120_000 });
  });

  it.each([413, 415, 422])("does not repeatedly retry a permanently rejected HTTP %i file", async (status) => {
    const request = vi.fn<typeof fetch>(async () => new Response("private", { status }));
    await expect(createScannerTransport(transportConfig, request)(entry(), pdf, digest(pdf)))
      .rejects.toMatchObject({ code: "IMPORT_REJECTED", retryable: false });
  });

  it("treats a broken connection after submission as retryable with the same content identity", async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error("private endpoint response"); });
    await expect(createScannerTransport(transportConfig, request)(entry(), pdf, digest(pdf)))
      .rejects.toMatchObject({ message: "IMPORT_RETRY", retryable: true });
  });

  it("stops for a missing intake deployment instead of permanently rejecting the invoice", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("not found", { status: 404 }));
    await expect(createScannerTransport(transportConfig, request)(entry(), pdf, digest(pdf)))
      .rejects.toMatchObject({ code: "CONFIGURATION_INVALID", retryable: false });
  });

  it("rejects oversized or malformed acknowledgements", async () => {
    for (const body of ["x".repeat(40_000), "{", JSON.stringify({ ...accepted, importId: "private/invalid" })]) {
      const request = vi.fn<typeof fetch>(async () => new Response(body));
      await expect(createScannerTransport(transportConfig, request)(entry(), pdf, digest(pdf)))
        .rejects.toMatchObject({ code: "IMPORT_RETRY" });
    }
  });
});

function configEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base = path.resolve(".local", "scanner-unit-config");
  return {
    NODE_ENV: "test", SCANNER_FOLDER: path.join(base, "source"), SCANNER_STATE_DIR: path.join(base, "state"),
    SCANNER_API_URL: "http://127.0.0.1:3012", SCANNER_SOURCE_ID: "source-test", SCANNER_TOKEN: "a".repeat(64),
    ...overrides,
  };
}
describe("scanner configuration boundaries", () => {
  it("uses secure defaults and does not need database, Azure or network-share credentials", () => {
    const config = parseScannerConfig(configEnvironment());
    expect(config).toMatchObject({ pollMs: 10_000, settleMs: 30_000 });
    expect(config.binding).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    { SCANNER_API_URL: "http://192.168.60.10" },
    { SCANNER_API_URL: "https://user:secret@example.invalid" },
    { SCANNER_API_URL: "https://example.invalid/path" },
    { SCANNER_API_URL: "https://example.invalid?token=private" },
    { SCANNER_TOKEN: "short" }, { SCANNER_FOLDER: "relative" },
    { SCANNER_SETTLE_SECONDS: "0" }, { SCANNER_POLL_SECONDS: "NaN" },
    { SCANNER_STATE_DIR: path.resolve("public", "scanner") },
  ])("rejects unsafe configuration without echoing input: %j", (override) => {
    expect(() => parseScannerConfig(configEnvironment(override))).toThrow("CONFIGURATION_INVALID");
  });
  it("rejects a state folder inside the scanner source", () => {
    const source = path.resolve(".local", "scanner-source");
    expect(() => parseScannerConfig(configEnvironment({ SCANNER_FOLDER: source, SCANNER_STATE_DIR: path.join(source, "state") })))
      .toThrow("CONFIGURATION_INVALID");
  });
  it("binds state to source, folder and origin while permitting token rotation", () => {
    const original = parseScannerConfig(configEnvironment());
    expect(parseScannerConfig(configEnvironment({ SCANNER_TOKEN: "b".repeat(64) })).binding).toBe(original.binding);
    expect(parseScannerConfig(configEnvironment({ SCANNER_SOURCE_ID: "another-source" })).binding).not.toBe(original.binding);
  });
});

async function diskFixture(): Promise<ScannerConfig> {
  const directory = path.resolve(".local", "scanner-worker-tests", randomUUID());
  const config = parseScannerConfig(configEnvironment({
    SCANNER_FOLDER: path.join(directory, "source"), SCANNER_STATE_DIR: path.join(directory, "state"),
  }));
  await mkdir(config.folder, { recursive: true });
  await writeFile(path.join(config.folder, "synthetic.pdf"), pdf);
  return config;
}
describe("real filesystem safety using generated local PDFs", () => {
  it("reads a bounded snapshot without changing or deleting the original", async () => {
    const config = await diskFixture(); const disk = createDiskScanner(config);
    const files = await disk.list(); expect(files).toHaveLength(1);
    expect(await disk.read(files[0])).toEqual(pdf);
    expect(await readFile(path.join(config.folder, "synthetic.pdf"))).toEqual(pdf);
    expect(await disk.list()).toEqual(files);
  });
  it("detects replacement between observation and reading", async () => {
    const config = await diskFixture(); const disk = createDiskScanner(config);
    const [file] = await disk.list();
    await writeFile(path.join(config.folder, "synthetic.pdf"), Buffer.concat([pdf, Buffer.from("changed")]));
    await expect(disk.read(file)).rejects.toMatchObject({ code: "FILE_CHANGED" });
  });
  it("ignores directories and non-PDF files", async () => {
    const config = await diskFixture();
    await writeFile(path.join(config.folder, "partial.tmp"), pdf);
    await mkdir(path.join(config.folder, "nested.pdf"));
    expect((await createDiskScanner(config).list()).map((value) => value.name)).toEqual(["synthetic.pdf"]);
  });
});

describe.skipIf(process.platform !== "win32")("real Windows handles and private journal", () => {
  it("refuses an existing writer and prevents a new writer during the read lock", async () => {
    const config = await diskFixture(); const filename = path.join(config.folder, "synthetic.pdf");
    const writer = await open(filename, "r+");
    try { await expect(holdWindowsFileLock(filename, "read")).rejects.toMatchObject({ code: "FILE_BUSY" }); }
    finally { await writer.close(); }
    const release = await holdWindowsFileLock(filename, "read");
    try { await expect(open(filename, "r+")).rejects.toBeDefined(); }
    finally { await release(); }
    expect(await readFile(filename)).toEqual(pdf);
  });

  it("serializes two workers and reloads the same journal after handle release/restart", async () => {
    const config = await diskFixture(); const first = await openScannerState(config);
    try {
      const state: ScannerState = { version: 1, binding: config.binding, initialized: true, includeExisting: false, files: {} };
      await first.save(state);
      await expect(openScannerState(config)).rejects.toMatchObject({ code: "STATE_IN_USE" });
      expect(await first.load()).toEqual(state);
    } finally { await first.close?.(); }
    const restarted = await openScannerState(config);
    try { expect(await restarted.load()).toMatchObject({ initialized: true, binding: config.binding }); }
    finally { await restarted.close?.(); }
  });

  it("refuses malformed persisted state instead of treating it as a new installation", async () => {
    const config = await diskFixture(); const store = await openScannerState(config);
    try {
      await writeFile(path.join(config.stateDirectory, "state.json"), "{corrupt");
      await expect(store.load()).rejects.toMatchObject({ code: "STATE_INVALID" });
    } finally { await store.close?.(); }
  });

  it("does not silently re-baseline when an initialized journal disappears", async () => {
    const config = await diskFixture(); const store = await openScannerState(config);
    try {
      await store.save({ version: 1, binding: config.binding, initialized: true, includeExisting: false, files: {} });
      // Move only our generated fixture journal to a sibling local fixture path; never a scanner file.
      const source = path.resolve(config.stateDirectory, "state.json");
      const destination = path.resolve(config.stateDirectory, "..", "saved-fixture-state.json");
      expect(path.dirname(source)).toBe(path.resolve(config.stateDirectory));
      expect(path.dirname(destination)).toBe(path.dirname(path.resolve(config.stateDirectory)));
      await rename(source, destination);
      await expect(store.load()).rejects.toMatchObject({ code: "STATE_INVALID" });
    } finally { await store.close?.(); }
  });

  it("refuses a directory containing unrelated files before changing its ACL", async () => {
    const config = await diskFixture();
    await mkdir(config.stateDirectory);
    await writeFile(path.join(config.stateDirectory, "unrelated.txt"), "fixture");
    await expect(openScannerState(config)).rejects.toMatchObject({ code: "STATE_INVALID" });
    expect(await readFile(path.join(config.stateDirectory, "unrelated.txt"), "utf8")).toBe("fixture");
  });

  it("protects the private journal directory with only the current Windows account", async () => {
    const config = await diskFixture(); const store = await openScannerState(config);
    try {
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$acl=Get-Acl -LiteralPath $env:BILLING_SCANNER_ACL_TEST; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); $current=[Security.Principal.WindowsIdentity]::GetCurrent().User; @{ protected=$acl.AreAccessRulesProtected; count=$rules.Count; onlyCurrent=(@($rules | Where-Object { $_.IdentityReference -ne $current }).Count -eq 0); inherited=(@($rules | Where-Object { $_.IsInherited }).Count -gt 0) } | ConvertTo-Json -Compress"], {
        windowsHide: true, encoding: "utf8", timeout: 5000,
        env: { ...process.env, BILLING_SCANNER_ACL_TEST: config.stateDirectory },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ protected: true, count: 1, onlyCurrent: true, inherited: false });
    } finally { await store.close?.(); }
  });

  it("releases the OS state lock after a worker process crashes and preserves its journal", async () => {
    const config = await diskFixture();
    const library = pathToFileURL(path.resolve("scripts", "lib", "scanner-worker.ts")).href;
    const script = `
      import { openScannerState } from ${JSON.stringify(library)};
      const config = ${JSON.stringify(config)};
      const store = await openScannerState(config);
      await store.save({ version:1, binding:config.binding, initialized:true, includeExisting:false, files:{} });
      console.log('READY');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--import=tsx", "--input-type=module", "-e", script], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, NODE_ENV: "test" },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture worker did not become ready.")), 8000);
        child.once("error", () => { clearTimeout(timer); reject(new Error("Fixture worker failed.")); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Fixture worker exited early.")); });
        child.stdout.on("data", (value: Buffer) => {
          if (value.toString("utf8").includes("READY")) { clearTimeout(timer); resolve(); }
        });
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await delay(300);
      const restarted = await openScannerState(config);
      try { expect(await restarted.load()).toMatchObject({ initialized: true, binding: config.binding }); }
      finally { await restarted.close?.(); }
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 20_000);

  it("rejects junctions used as a private state directory", async () => {
    const config = await diskFixture(); const target = `${config.stateDirectory}-target`;
    await mkdir(target); await symlink(target, config.stateDirectory, "junction");
    await expect(openScannerState(config)).rejects.toMatchObject({ code: "STATE_INVALID" });
  });
});
