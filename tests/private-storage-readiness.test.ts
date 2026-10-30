import { mkdir, mkdtemp, rmdir, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storePrivateDocument } from "@/lib/services/documents";
vi.mock("@/lib/db", () => ({ db: {} }));

const fixture = () =>
  new File(["%PDF-1.4\nFictional audit fixture\n%%EOF"], "fixture.pdf", {
    type: "application/pdf",
  });
beforeEach(() => vi.stubEnv("APP_ENV", "test"));
afterEach(() => vi.unstubAllEnvs());

describe("private storage deployment boundaries", () => {
  it.each(["public", ".next", path.join(".next", "static")])(
    "refuses uploads inside %s before creating files",
    async (root) => {
      vi.stubEnv(
        "UPLOAD_DIR",
        path.resolve(root, "forbidden-security-fixture"),
      );
      await expect(storePrivateDocument(fixture())).rejects.toMatchObject({
        status: 503,
      });
    },
  );
  it("refuses a junction or symlink that resolves into a served build directory", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "voltronix-private-path-fixture-"),
    );
    const alias = path.join(directory, "misconfigured-uploads");
    const build = path.join(directory, ".next");
    await mkdir(build);
    const workingDirectory = vi
      .spyOn(process, "cwd")
      .mockReturnValue(directory);
    try {
      await symlink(
        build,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      vi.stubEnv("UPLOAD_DIR", alias);
      await expect(storePrivateDocument(fixture())).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      workingDirectory.mockRestore();
      // Unlink the junction itself; never recurse into its application target.
      await unlink(alias).catch(() => undefined);
      await rmdir(build);
      await rmdir(directory);
    }
  });
});
