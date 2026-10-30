import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  lstat, mkdir, open, opendir, readFile, realpath, rename, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_SCANNER_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const libraryDirectory = path.dirname(fileURLToPath(import.meta.url));

export type ScannerCode =
  | "CONFIGURATION_INVALID" | "STATE_INVALID" | "STATE_UNAVAILABLE"
  | "STATE_IN_USE" | "NETWORK_UNAVAILABLE" | "FILE_BUSY"
  | "FILE_CHANGED" | "INVALID_PDF" | "FILE_TOO_LARGE"
  | "SOURCE_TOO_LARGE" | "AUTHORIZATION_FAILED" | "IMPORT_RETRY"
  | "IMPORT_REJECTED";

export class ScannerError extends Error {
  constructor(
    readonly code: ScannerCode,
    readonly retryable = false,
    readonly retryAfterMs = 0,
  ) { super(code); }
}

export interface ScannerConfig {
  folder: string;
  apiOrigin: string;
  sourceId: string;
  token: string;
  stateDirectory: string;
  pollMs: number;
  settleMs: number;
  binding: string;
}

function inside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function normalizedPath(value: string) {
  const result = path.resolve(value);
  return process.platform === "win32" ? result.toLowerCase() : result;
}

export function parseScannerConfig(environment: Record<string, string | undefined>): ScannerConfig {
  try {
    const folder = environment.SCANNER_FOLDER?.trim() ?? "";
    const stateDirectory = environment.SCANNER_STATE_DIR?.trim() ?? "";
    const sourceId = environment.SCANNER_SOURCE_ID?.trim() ?? "";
    const token = environment.SCANNER_TOKEN?.trim() ?? "";
    const url = new URL(environment.SCANNER_API_URL ?? "");
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      !path.isAbsolute(folder) || !path.isAbsolute(stateDirectory) ||
      (process.platform === "win32" && stateDirectory.startsWith("\\\\")) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId) || !/^[a-f0-9]{64}$/.test(token) ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/"
    ) throw new Error();
    for (const forbidden of [folder, path.resolve("public"), path.resolve(".next")]) {
      if (inside(path.resolve(stateDirectory), path.resolve(forbidden))) throw new Error();
    }
    // A parent state directory could change permissions on the source or the application.
    if (inside(path.resolve(folder), path.resolve(stateDirectory)) ||
        inside(path.resolve(process.cwd()), path.resolve(stateDirectory))) throw new Error();
    const seconds = (raw: string | undefined, fallback: number, minimum: number, maximum: number) => {
      if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error();
      const value = raw === undefined ? fallback : Number(raw);
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error();
      return value * 1000;
    };
    return {
      folder: path.resolve(folder), apiOrigin: url.origin, sourceId, token,
      stateDirectory: path.resolve(stateDirectory),
      pollMs: seconds(environment.SCANNER_POLL_SECONDS, 10, 1, 300),
      settleMs: seconds(environment.SCANNER_SETTLE_SECONDS, 30, 2, 3600),
      binding: createHash("sha256").update(JSON.stringify([
        normalizedPath(folder), url.origin, sourceId,
      ])).digest("hex"),
    };
  } catch { throw new ScannerError("CONFIGURATION_INVALID"); }
}

export interface ScannerEntry { name: string; fingerprint: string; size: number }
export interface ScannerDisk {
  list(): Promise<ScannerEntry[]>;
  read(entry: ScannerEntry): Promise<Buffer>;
}
export interface ImportReceipt {
  importId: string;
  status: "IMPORTED" | "DUPLICATE";
  duplicate: boolean;
}
export type ScannerTransport = (entry: ScannerEntry, bytes: Buffer, sha256: string) => Promise<ImportReceipt>;
type FileStatus = "BASELINE" | "WAITING" | "SUBMITTED" | "REJECTED";
interface FileState {
  fingerprint: string;
  stableSince: number;
  observations: number;
  status: FileStatus;
  failures: number;
  nextAttemptAt: number;
  code?: ScannerCode;
  sha256?: string;
}
export interface ScannerState {
  version: 1;
  binding: string;
  initialized: boolean;
  includeExisting: boolean;
  files: Record<string, FileState>;
}
export interface ScannerStateStore {
  load(): Promise<ScannerState | null>;
  save(state: ScannerState): Promise<void>;
  close?(): Promise<void>;
}
export interface ScanReport {
  event: "scan" | "baseline" | "network_retry" | "deferred";
  observed: number;
  baseline: number;
  submitted: number;
  duplicates: number;
  waiting: number;
  failed: number;
  retrying: number;
  code?: ScannerCode;
}

function emptyReport(event: ScanReport["event"]): ScanReport {
  return { event, observed: 0, baseline: 0, submitted: 0, duplicates: 0, waiting: 0, failed: 0, retrying: 0 };
}
function entryKey(name: string) {
  // No names or UNC paths are persisted in the local journal or emitted in logs.
  return createHash("sha256").update(process.platform === "win32" ? name.toLowerCase() : name).digest("hex");
}
function safeName(name: string) {
  return name.length > 0 && name.length <= 255 && name === path.basename(name) &&
    !/[\\/:<>|?*\u0000-\u001f\u007f]/.test(name) && /\.pdf$/i.test(name);
}
export function validateScannerPdf(bytes: Buffer) {
  if (bytes.length > MAX_SCANNER_BYTES) throw new ScannerError("FILE_TOO_LARGE");
  if (bytes.length < 14 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-" ||
      !/%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.test(bytes.subarray(-2048).toString("latin1")))
    throw new ScannerError("INVALID_PDF");
}
function backoff(failures: number) {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.min(8, Math.max(0, failures - 1)));
}

/** Polls only; MySQL remains the authority for duplicate hashes and OCR lifecycle. */
export class ScannerWorker {
  private state: ScannerState | null = null;
  private networkFailures = 0;
  private nextScanAt = 0;
  private ticking = false;
  constructor(
    private readonly config: Pick<ScannerConfig, "binding" | "settleMs">,
    private readonly disk: ScannerDisk,
    private readonly transport: ScannerTransport,
    private readonly store: ScannerStateStore,
    private readonly options: { includeExisting?: boolean; now?: () => number } = {},
  ) {}

  async tick(): Promise<ScanReport> {
    if (this.ticking) throw new ScannerError("STATE_IN_USE");
    this.ticking = true;
    try { return await this.runTick(); } finally { this.ticking = false; }
  }

  private async runTick(): Promise<ScanReport> {
    const now = this.options.now?.() ?? Date.now();
    if (!this.state) {
      this.state = await this.store.load() ?? {
        version: 1, binding: this.config.binding, initialized: false,
        includeExisting: Boolean(this.options.includeExisting), files: {},
      };
      if (this.state.binding !== this.config.binding ||
          (this.options.includeExisting && !this.state.includeExisting))
        throw new ScannerError("STATE_INVALID");
    }
    if (now < this.nextScanAt) return emptyReport("deferred");
    let entries: ScannerEntry[];
    try {
      entries = await this.disk.list();
      if (entries.length > MAX_ENTRIES) throw new ScannerError("SOURCE_TOO_LARGE");
      if (entries.some((entry) => !safeName(entry.name))) throw new ScannerError("SOURCE_TOO_LARGE");
    } catch (error) {
      this.networkFailures++;
      this.nextScanAt = now + backoff(this.networkFailures);
      return { ...emptyReport("network_retry"), code: error instanceof ScannerError ? error.code : "NETWORK_UNAVAILABLE" };
    }
    this.networkFailures = 0;
    this.nextScanAt = 0;
    const report = emptyReport("scan");
    report.observed = entries.length;
    const initialBaseline = !this.state.initialized && !this.state.includeExisting;
    const activeKeys = new Set(entries.map((entry) => entryKey(entry.name)));
    // Missing files need no local state: reappearing content is checked against durable server hashes.
    // Never prune after a failed or partial directory scan.
    for (const key of Object.keys(this.state.files)) {
      if (!activeKeys.has(key)) delete this.state.files[key];
    }
    for (const entry of entries) {
      const key = entryKey(entry.name);
      const previous = this.state.files[key];
      if (!previous || previous.fingerprint !== entry.fingerprint) {
        this.state.files[key] = {
          fingerprint: entry.fingerprint, stableSince: now, observations: 1,
          status: initialBaseline ? "BASELINE" : "WAITING", failures: 0, nextAttemptAt: 0,
        };
      } else previous.observations = Math.min(2, previous.observations + 1);
    }
    this.state.initialized = true;
    // Persist observations BEFORE submitting anything. Restart must not re-baseline new arrivals.
    await this.store.save(this.state);
    if (initialBaseline) {
      report.event = "baseline";
      report.baseline = entries.length;
      return report;
    }
    for (const entry of entries) {
      const current = this.state.files[entryKey(entry.name)];
      if (current.status === "BASELINE") { report.baseline++; continue; }
      if (current.status === "SUBMITTED") continue;
      if (current.status === "REJECTED") { report.failed++; continue; }
      if (current.observations < 2 || now - current.stableSince < this.config.settleMs || now < current.nextAttemptAt) {
        report.waiting++;
        continue;
      }
      try {
        if (entry.size > MAX_SCANNER_BYTES) throw new ScannerError("FILE_TOO_LARGE");
        const bytes = await this.disk.read(entry);
        validateScannerPdf(bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        current.sha256 = sha256;
        const receipt = await this.transport(entry, bytes, sha256);
        current.status = "SUBMITTED";
        current.failures = 0;
        delete current.code;
        report.submitted++;
        if (receipt.duplicate) report.duplicates++;
      } catch (error) {
        const failure = error instanceof ScannerError ? error : new ScannerError("NETWORK_UNAVAILABLE", true);
        if (failure.code === "AUTHORIZATION_FAILED" || failure.code === "CONFIGURATION_INVALID") {
          current.code = failure.code;
          await this.store.save(this.state);
          throw failure;
        }
        current.failures = Math.min(32, current.failures + 1);
        current.code = failure.code;
        if (failure.code === "FILE_CHANGED" || failure.code === "FILE_BUSY") {
          current.stableSince = now;
          current.observations = 1;
        }
        // Missing EOF may be an incomplete copy. Recheck after backoff; never submit it.
        const retryable = failure.retryable || failure.code === "INVALID_PDF";
        if (retryable) {
          current.nextAttemptAt = now + Math.max(backoff(current.failures), failure.retryAfterMs);
          report.retrying++;
        } else { current.status = "REJECTED"; report.failed++; }
      }
      await this.store.save(this.state);
    }
    return report;
  }
}

function childEnvironment(extra: Record<string, string>) {
  // Do not pass the API token, DB URL or unrelated application secrets to helper processes.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|PSMODULEPATH)$/i.test(key)));
  return { ...environment, NODE_ENV: process.env.NODE_ENV ?? "production", ...extra };
}

/** Windows locks are held by the OS and release on crash/closed stdin, leaving no stale lock problem. */
interface HeldLock {
  (): Promise<void>;
  assertHeld(): void;
}
export async function holdWindowsFileLock(target: string, mode: "read" | "state"): Promise<HeldLock> {
  if (process.platform !== "win32") throw new ScannerError("CONFIGURATION_INVALID");
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(libraryDirectory, "scanner-file-lock.ps1")], {
    windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    env: childEnvironment({ BILLING_SCANNER_LOCK_PATH: target, BILLING_SCANNER_LOCK_MODE: mode }),
  });
  const code = mode === "state" ? "STATE_IN_USE" : "FILE_BUSY";
  let exited = false;
  child.once("exit", () => { exited = true; });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new ScannerError(code, mode === "read")); }, 10_000);
    child.once("error", () => { clearTimeout(timer); reject(new ScannerError(code, mode === "read")); });
    child.once("exit", () => { clearTimeout(timer); reject(new ScannerError(code, mode === "read")); });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("ascii");
      if (output.length > 32) { child.kill(); clearTimeout(timer); reject(new ScannerError(code, mode === "read")); }
      if (output.trim() === "READY") { clearTimeout(timer); resolve(); }
    });
  });
  let released = false;
  // A blocked SMB read must not keep a scanner file locked indefinitely.
  const holdTimer = mode === "read" ? setTimeout(() => { child.kill(); }, 35_000) : undefined;
  const release = async () => {
    if (released) return;
    released = true;
    clearTimeout(holdTimer);
    if (exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.stdin.on("error", () => { child.kill(); });
      child.stdin.end("release\n");
    });
  };
  return Object.assign(release, {
    assertHeld() { if (exited || released) throw new ScannerError(code, mode === "read"); },
  });
}

function fingerprint(stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }) {
  return createHash("sha256").update(JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev])).digest("hex");
}
export function createDiskScanner(config: Pick<ScannerConfig, "folder">): ScannerDisk {
  const root = path.resolve(config.folder);
  const pending = { list: false, read: false };
  const bounded = async <T>(operation: "list" | "read", run: () => Promise<T>): Promise<T> => {
    if (pending[operation]) throw new ScannerError("NETWORK_UNAVAILABLE", true);
    pending[operation] = true;
    // Node cannot cancel an in-flight SMB system call. At most one of each operation
    // remains pending after a timeout; its late result is discarded, never imported.
    const work = run().finally(() => { pending[operation] = false; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ScannerError("NETWORK_UNAVAILABLE", true)), 30_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const rootPath = async () => {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ScannerError("NETWORK_UNAVAILABLE", true);
    return realpath(root);
  };
  return {
    list: () => bounded("list", async () => {
      try {
        const physicalRoot = await rootPath();
        const result: ScannerEntry[] = [];
        let seen = 0;
        const directory = await opendir(physicalRoot);
        for await (const entry of directory) {
          if (++seen > MAX_ENTRIES) throw new ScannerError("SOURCE_TOO_LARGE");
          if (!entry.isFile() || entry.isSymbolicLink() || !safeName(entry.name)) continue;
          const candidate = path.join(physicalRoot, entry.name);
          const stat = await lstat(candidate);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          result.push({ name: entry.name, fingerprint: fingerprint(stat), size: stat.size });
        }
        return result;
      } catch (error) {
        if (error instanceof ScannerError) throw error;
        throw new ScannerError("NETWORK_UNAVAILABLE", true);
      }
    }),
    read: (entry) => bounded("read", async () => {
      if (!safeName(entry.name)) throw new ScannerError("INVALID_PDF");
      let release: HeldLock | undefined;
      try {
        const physicalRoot = await rootPath();
        const filename = path.join(physicalRoot, entry.name);
        const first = await lstat(filename);
        const resolved = await realpath(filename);
        if (!first.isFile() || first.isSymbolicLink() || !inside(resolved, physicalRoot) ||
            fingerprint(first) !== entry.fingerprint) throw new ScannerError("FILE_CHANGED", true);
        if (first.size > MAX_SCANNER_BYTES) throw new ScannerError("FILE_TOO_LARGE");
        if (process.platform === "win32") release = await holdWindowsFileLock(filename, "read");
        const handle = await open(filename, "r");
        try {
          const before = await handle.stat();
          if (fingerprint(before) !== entry.fingerprint) throw new ScannerError("FILE_CHANGED", true);
          // Allocate at most the advertised bounded file size and never call unbounded readFile on the share.
          const bytes = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) throw new ScannerError("FILE_CHANGED", true);
            offset += bytesRead;
          }
          const after = await handle.stat();
          const finalPath = await lstat(filename);
          if (fingerprint(after) !== entry.fingerprint || fingerprint(finalPath) !== entry.fingerprint || finalPath.isSymbolicLink())
            throw new ScannerError("FILE_CHANGED", true);
          release?.assertHeld();
          return bytes;
        } finally { await handle.close(); }
      } catch (error) {
        if (error instanceof ScannerError) throw error;
        throw new ScannerError("NETWORK_UNAVAILABLE", true);
      } finally { await release?.(); }
    }),
  };
}

async function boundedJson(response: Response) {
  if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES || !response.body)
    throw new ScannerError("IMPORT_RETRY", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ScannerError("IMPORT_RETRY", true); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch { throw new ScannerError("IMPORT_RETRY", true); }
}
export function createScannerTransport(
  config: Pick<ScannerConfig, "apiOrigin" | "sourceId" | "token">,
  request: typeof fetch = fetch,
): ScannerTransport {
  return async (entry, bytes, sha256) => {
    let response: Response;
    try {
      response = await request(new URL("/api/scanner/imports", config.apiOrigin), {
        method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(60_000),
        headers: {
          authorization: `Bearer ${config.token}`, "content-type": "application/pdf",
          "x-scanner-source": config.sourceId, "x-scanner-sha256": sha256,
          "x-scanner-file-name": encodeURIComponent(entry.name),
        },
        body: new Uint8Array(bytes),
      });
    } catch { throw new ScannerError("IMPORT_RETRY", true); }
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new ScannerError("AUTHORIZATION_FAILED"); }
    if ([408, 409, 425, 429].includes(response.status) || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      await response.body?.cancel();
      throw new ScannerError("IMPORT_RETRY", true, Number.isFinite(retryAfter) ? Math.min(900_000, Math.max(0, retryAfter * 1000)) : 0);
    }
    if ([413, 415, 422].includes(response.status)) { await response.body?.cancel(); throw new ScannerError("IMPORT_REJECTED"); }
    if ([400, 404, 405, 406, 411].includes(response.status)) { await response.body?.cancel(); throw new ScannerError("CONFIGURATION_INVALID"); }
    if (![200, 201].includes(response.status)) { await response.body?.cancel(); throw new ScannerError("IMPORT_RETRY", true); }
    const result = await boundedJson(response);
    if (typeof result !== "object" || result === null || !("importId" in result) ||
        typeof result.importId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.importId) ||
        !("status" in result) || !["IMPORTED", "DUPLICATE"].includes(String(result.status)) ||
        !("duplicate" in result) || typeof result.duplicate !== "boolean")
      throw new ScannerError("IMPORT_RETRY", true);
    return { importId: result.importId, status: result.status as ImportReceipt["status"], duplicate: result.duplicate };
  };
}

function validState(value: unknown, binding: string): value is ScannerState {
  if (!value || typeof value !== "object") return false;
  const state = value as ScannerState;
  if (state.version !== 1 || state.binding !== binding || typeof state.initialized !== "boolean" ||
      typeof state.includeExisting !== "boolean" || !state.files || typeof state.files !== "object" || Array.isArray(state.files)) return false;
  const entries = Object.entries(state.files);
  return entries.length <= MAX_ENTRIES && entries.every(([key, file]) =>
    /^[a-f0-9]{64}$/.test(key) && file && typeof file === "object" &&
    /^[a-f0-9]{64}$/.test(file.fingerprint) &&
    ["BASELINE", "WAITING", "SUBMITTED", "REJECTED"].includes(file.status) &&
    [file.stableSince, file.observations, file.failures, file.nextAttemptAt].every((item) => Number.isFinite(item) && item >= 0) &&
    (file.sha256 === undefined || /^[a-f0-9]{64}$/.test(file.sha256)));
}
async function rejectReparseAncestors(directory: string) {
  let current = directory;
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new ScannerError("STATE_INVALID"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function openScannerState(config: ScannerConfig): Promise<ScannerStateStore> {
  // The supported unattended deployment is Windows. This prevents a weak portable lock fallback.
  if (process.platform !== "win32") throw new ScannerError("CONFIGURATION_INVALID");
  let release: HeldLock | undefined;
  try {
    const directory = config.stateDirectory;
    // Refuse mapped network drives too, before mkdir or ACL changes can touch a share.
    const localDrive = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; try { $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:BILLING_SCANNER_STATE_DIRECTORY)); if ($drive.DriveType -ne [IO.DriveType]::Fixed) { exit 71 } } catch { exit 72 }"], {
      windowsHide: true, stdio: "ignore", timeout: 10_000,
      env: childEnvironment({ BILLING_SCANNER_STATE_DIRECTORY: directory }),
    });
    if (localDrive.status !== 0 || localDrive.error) throw new ScannerError("STATE_INVALID");
    await rejectReparseAncestors(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const physical = await realpath(directory);
    if (normalizedPath(physical) !== normalizedPath(directory)) throw new ScannerError("STATE_INVALID");
    const contents = await opendir(directory);
    for await (const item of contents) {
      if (!item.isFile() || item.isSymbolicLink() ||
          !/^(?:state\.json|worker\.lock|initialized|state-[a-f0-9-]{36}\.tmp)$/.test(item.name))
        throw new ScannerError("STATE_INVALID");
    }
    const acl = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(libraryDirectory, "scanner-private-directory.ps1")], {
      windowsHide: true, stdio: "ignore", timeout: 10_000,
      env: childEnvironment({ BILLING_SCANNER_STATE_DIRECTORY: directory }),
    });
    if (acl.status !== 0 || acl.error) throw new ScannerError("STATE_UNAVAILABLE");
    const stateFile = path.join(directory, "state.json");
    const lockFile = path.join(directory, "worker.lock");
    const initializedFile = path.join(directory, "initialized");
    for (const target of [stateFile, lockFile]) {
      try { if ((await lstat(target)).isSymbolicLink()) throw new ScannerError("STATE_INVALID"); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (target === lockFile && ["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw new ScannerError("STATE_IN_USE");
        if (code !== "ENOENT") throw error;
      }
    }
    release = await holdWindowsFileLock(lockFile, "state");
    const close = release;
    let closed = false;
    return {
      async load() {
        if (closed) throw new ScannerError("STATE_UNAVAILABLE");
        close.assertHeld();
        try {
          const stat = await lstat(stateFile);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw new ScannerError("STATE_INVALID");
          const value: unknown = JSON.parse(await readFile(stateFile, "utf8"));
          if (!validState(value, config.binding)) throw new ScannerError("STATE_INVALID");
          return value;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            try { await lstat(initializedFile); }
            catch (markerError) { if ((markerError as NodeJS.ErrnoException).code === "ENOENT") return null; }
          }
          throw new ScannerError("STATE_INVALID");
        }
      },
      async save(state) {
        if (closed || !validState(state, config.binding)) throw new ScannerError("STATE_INVALID");
        close.assertHeld();
        const temporary = path.join(directory, `state-${randomUUID()}.tmp`);
        try {
          const bytes = JSON.stringify(state);
          if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw new ScannerError("STATE_INVALID");
          const handle = await open(temporary, "wx", 0o600);
          try { await handle.writeFile(bytes, "utf8"); await handle.sync(); } finally { await handle.close(); }
          close.assertHeld();
          await rename(temporary, stateFile);
          close.assertHeld();
          // Losing a once-initialized journal must never silently skip new files on restart.
          try { await writeFile(initializedFile, config.binding, { flag: "wx", mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        } catch { throw new ScannerError("STATE_UNAVAILABLE"); }
      },
      async close() { if (!closed) { closed = true; await close(); } },
    };
  } catch (error) {
    await release?.();
    if (error instanceof ScannerError) throw error;
    throw new ScannerError("STATE_UNAVAILABLE");
  }
}
