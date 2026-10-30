import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AttachmentDownloadState } from "../../src/lib/services/books-attachment-download";

const date = z.iso.datetime({ offset: true });
const quotaSchema = z.object({ limit: z.number().int().nonnegative().nullable(), remaining: z.number().int().nonnegative().nullable(), resetAt: date.nullable(), observedAt: date.nullable(), notBefore: date.nullable(), reason: z.string().max(100).nullable() }).strict();
const stateSchema = z.object({ version: z.literal(1), scopeHash: z.string().regex(/^[a-f0-9]{64}$/), startedAt: date, updatedAt: date,
  status: z.enum(["RUNNING", "WAITING", "PARTIAL", "COMPLETE", "INTERRUPTED"]), providerReads: z.number().int().nonnegative(), providerFinancialWrites: z.literal(0),
  expected: z.number().int().nonnegative(), available: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), metadataPendingBills: z.number().int().nonnegative(), nextResumeAt: date.nullable(),
  organizations: z.record(z.string().regex(/^\d{1,30}$/), z.object({ expected: z.number().int().nonnegative(), available: z.number().int().nonnegative(), quota: quotaSchema }).strict()),
  failures: z.array(z.object({ billId: z.string().min(1).max(100), externalDocumentId: z.string().max(100), code: z.string().regex(/^[A-Z0-9_]{1,100}$/) }).strict()).max(100_000),
}).strict();

export function parseAttachmentDownloadArguments(arguments_: string[]) {
  let wait = false;
  let state: string | undefined;
  const notBefore = new Map<string, string>();
  const organizations: string[] = [];
  for (const argument of arguments_) {
    if (argument === "--wait" && !wait) wait = true;
    else if (argument.startsWith("--state=") && !state) state = argument.slice(8);
    else if (argument.startsWith("--organization=")) {
      const id = argument.slice(15);
      if (!/^\d{1,30}$/.test(id) || organizations.includes(id)) throw new Error("Invalid organization option.");
      organizations.push(id);
    } else if (argument.startsWith("--not-before-org=")) {
      const match = argument.slice(17).match(/^(\d{1,30}):(.+)$/);
      if (!match || !date.safeParse(match[2]).success || notBefore.has(match[1])) throw new Error("Invalid organization resume time.");
      notBefore.set(match[1], new Date(match[2]).toISOString());
    } else throw new Error("Unknown or duplicated attachment downloader option.");
  }
  if (state !== undefined && !state.trim()) throw new Error("An explicit state filename is required.");
  return { wait, state: state ?? process.env.BOOKS_ATTACHMENTS_STATE_FILE ?? ".local/mysql-dev/books-attachment-download/progress.json", notBefore, organizations };
}

function inside(file: string, root: string) {
  const relative = path.relative(root, file);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
export async function privateAttachmentStateFile(configured: string) {
  const file = path.resolve(configured);
  const roots = [path.resolve("public"), path.resolve(".next"), path.resolve("src"), path.resolve("node_modules")];
  if (roots.some((root) => inside(file, root)) || path.extname(file) !== ".json") throw new Error("Attachment progress must use a private JSON file outside application assets.");
  const uploadRoot = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : null;
  if (inside(file, process.cwd()) && !inside(file, path.resolve(".local")) && !(uploadRoot && inside(file, uploadRoot)))
    throw new Error("Workspace attachment progress must remain in .local or the configured private uploads directory.");
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const physicalDirectory = await realpath(directory);
  const physicalRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
  if (physicalRoots.some((root) => inside(physicalDirectory, root))) throw new Error("Attachment state must not resolve inside application assets.");
  const filename = path.join(physicalDirectory, path.basename(file));
  try { const stat = await lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Attachment state must be a regular private file."); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
  return filename;
}

export async function readAttachmentDownloadState(filename: string): Promise<AttachmentDownloadState | null> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid attachment progress file.");
    return stateSchema.parse(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeAttachmentDownloadState(filename: string, state: AttachmentDownloadState) {
  stateSchema.parse(state);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { await rename(temporary, filename); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

/** Same-host dead-process locks may be recovered; live/remote/ambiguous owners always block. */
export async function lockAttachmentDownloadState(filename: string) {
  const lockfile = `${filename}.lock`;
  const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  try { await writeFile(lockfile, JSON.stringify(owner), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const stat = await lstat(lockfile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("The attachment downloader lock is invalid.");
    const old = z.object({ pid: z.number().int().positive(), host: z.string(), token: z.string().uuid() }).strict().parse(JSON.parse(await readFile(lockfile, "utf8")));
    if (old.host !== owner.host) throw new Error("Another host owns this attachment downloader state.");
    let alive = true;
    try { process.kill(old.pid, 0); } catch (failure) { if (failure && typeof failure === "object" && "code" in failure && failure.code === "ESRCH") alive = false; }
    if (alive) throw new Error("An attachment downloader already owns this state.");
    // Re-read before removing only this known stale lock; never recursively remove a directory.
    if (JSON.parse(await readFile(lockfile, "utf8")).token !== old.token) throw new Error("The downloader lock changed.");
    await unlink(lockfile);
    await writeFile(lockfile, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  }
  return async () => {
    const current = JSON.parse(await readFile(lockfile, "utf8"));
    if (current.token !== owner.token) throw new Error("The downloader lock changed before release.");
    await unlink(lockfile);
  };
}
