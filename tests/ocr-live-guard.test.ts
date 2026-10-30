import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "test-ocr-live.mjs");

/** Execute the real CLI, while forbidding .env reads and all provider networking. */
function guardedRun(
  arguments_: string[],
  overrides: Record<string, string> = {},
) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME|USERPROFILE)$/i.test(
          key,
        ),
    ),
  );
  const wrapper = `
    import fs from 'node:fs';
    import path from 'node:path';
    const target = ${JSON.stringify(path.join(root, ".env"))};
    let environmentProbes = 0, environmentReads = 0, networkCalls = 0;
    const exists = fs.existsSync, read = fs.readFileSync;
    const isEnvironment = value => typeof value === 'string' && path.resolve(value) === target;
    fs.existsSync = value => {
      if (isEnvironment(value)) { environmentProbes++; return false; }
      return exists(value);
    };
    fs.readFileSync = (value, ...options) => {
      if (isEnvironment(value)) { environmentReads++; throw new Error('Real environment reads are forbidden in this guard test.'); }
      return read(value, ...options);
    };
    globalThis.fetch = async () => { networkCalls++; throw new Error('External requests are forbidden in this guard test.'); };
    process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(arguments_)}];
    await import(${JSON.stringify(pathToFileURL(script).href)});
    console.log(JSON.stringify({environmentProbes, environmentReads, networkCalls}));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import=tsx",
      "--input-type=module",
      "-e",
      wrapper,
    ],
    {
      cwd: root,
      env: { ...environment, NODE_ENV: "test", APP_ENV: "development", ...overrides },
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  const evidence = JSON.parse(result.stdout.trim());
  expect(evidence.environmentReads).toBe(0);
  expect(evidence.networkCalls).toBe(0);
  return { evidence, message: result.stderr };
}

describe("live Azure acceptance safety gates", () => {
  it.each([[], ["--unknown"], ["--allow-live", "--extra"]])(
    "requires exactly the explicit live opt-in before inspecting environment files: %j",
    (...arguments_: string[]) => {
      // it.each spreads each row; the CLI must reject every supplied variant.
      const result = guardedRun(arguments_);
      expect(result.evidence.environmentProbes).toBe(0);
      expect(result.message).toContain("Live Azure test not started");
    },
  );

  it("does not send a request when credentials are missing", () => {
    const result = guardedRun(["--allow-live"]);
    expect(result.evidence.environmentProbes).toBe(1);
    expect(result.message).toContain("No request was sent");
  });

  it("does not accept whitespace credentials as a configured live test", () => {
    const result = guardedRun(["--allow-live"], {
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT:
        "https://fictional-ocr.cognitiveservices.azure.com/",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "   ",
    });
    expect(result.message).toContain("No request was sent");
  });

  it("refuses the live acceptance runner outside development", () => {
    const result = guardedRun(["--allow-live"], {
      APP_ENV: "production",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT:
        "https://fictional-ocr.cognitiveservices.azure.com/",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "fictional-live-test-key",
    });
    expect(result.message).toContain("development environment");
    expect(result.message).not.toContain("fictional-live-test-key");
  });

  it("rejects a foreign resource before credentials can be sent", () => {
    const result = guardedRun(["--allow-live"], {
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT:
        "https://untrusted.example.invalid/",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "fictional-live-test-key",
    });
    expect(result.message).toContain("endpoint/key configuration is invalid");
    expect(result.message).not.toContain("fictional-live-test-key");
  });
});
