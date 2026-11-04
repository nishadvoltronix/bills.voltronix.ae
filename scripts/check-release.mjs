import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { constants, existsSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Scan configured credentials, never public settings or source-code fixtures.
// Short credentials can leak too; there is deliberately no minimum length.
const credentialName =
  /(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY|ACCESS_KEY)(?:_(?:CURRENT|PREVIOUS|NEXT|OLD|NEW|\d+))?$/i;
const connectionName = /(?:DATABASE_URL|DB_URL|CONNECTION_STRING)$/i;

/** @param {Record<string, string | undefined>} environment */
export function configuredSecrets(environment) {
  const values = new Set();
  const add = (value) => {
    if (!value) return;
    values.add(value);
    values.add(JSON.stringify(value).slice(1, -1));
    values.add(encodeURIComponent(value));
  };
  for (const [name, value] of Object.entries(environment)) {
    if (!value) continue;
    if (
      credentialName.test(name) ||
      /^(?:PGPASSWORD|PGPASS|AZURE_DOCUMENT_INTELLIGENCE_KEY)$/i.test(name)
    )
      add(value);
    if (name === "ZOHO_BOOKS_REFRESH_TOKENS_JSON") {
      add(value);
      try {
        const tokens = JSON.parse(value);
        if (tokens && typeof tokens === "object" && !Array.isArray(tokens) &&
          Object.values(tokens).every((token) => typeof token === "string")) {
          // Include original values even if invalid duplicate keys were overwritten
          // by JSON.parse. Valid flat maps alternate string key/value literals.
          const literals = value.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
          for (let index = 1; index < literals.length; index += 2)
            add(JSON.parse(literals[index]));
        }
      } catch {
        // Still scan the full value; never emit malformed credentials.
      }
    }
    if (connectionName.test(name)) {
      add(value);
      try {
        const connection = new URL(value);
        add(connection.password);
        add(decodeURIComponent(connection.password));
        for (const key of ["password", "pass", "pwd"])
          add(connection.searchParams.get(key));
      } catch {
        // Still scan the full value; never emit malformed credentials.
      }
    }
  }
  return [...values];
}

/** Read file-backed credentials at inspection time, never during module import/build. */
export async function configuredSecretFiles(environment) {
  const secrets = new Set();
  const paths = new Set();
  for (const [name, value] of Object.entries(environment)) {
    if (!name.endsWith("_FILE") || !credentialName.test(name.slice(0, -5)) || !value) continue;
    if (!path.isAbsolute(value)) throw new Error("A configured credential file must use an absolute path.");
    if ((await lstat(value)).isSymbolicLink()) throw new Error("A configured credential file must be a regular file.");
    const file = await open(value, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const information = await file.stat();
      if (!information.isFile() || information.size === 0 || information.size > 65_536)
        throw new Error("A configured credential file could not be inspected safely.");
      const bytes = Buffer.alloc(65_537);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead === 0 || bytesRead > 65_536)
        throw new Error("A configured credential file could not be inspected safely.");
      const secret = bytes.subarray(0, bytesRead).toString("utf8").trim();
      if (!secret) throw new Error("A configured credential file is empty.");
      for (const variant of configuredSecrets({ RUNTIME_API_KEY: secret })) secrets.add(variant);
      paths.add(path.resolve(value));
    } finally {
      await file.close();
    }
  }
  return { secrets: [...secrets], paths: [...paths] };
}

/** @param {string} directory */
async function filesUnder(directory) {
  const result = [];
  if (!existsSync(directory)) return result;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(file)));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

/** @param {string} buildDirectory @param {Record<string, string | undefined>} environment */
export async function inspectRelease(buildDirectory, environment) {
  if (!existsSync(buildDirectory))
    throw new Error(
      "Run a production build before checking release artifacts.",
    );
  const fileCredentials = await configuredSecretFiles(environment);
  const secrets = [...configuredSecrets(environment), ...fileCredentials.secrets];
  const privateFiles = new Set(fileCredentials.paths);
  const files = [
    ...(await filesUnder(path.join(buildDirectory, "server"))),
    ...(await filesUnder(path.join(buildDirectory, "static"))),
    ...(await readdir(buildDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(?:js|json)$/.test(entry.name))
      .map((entry) => path.join(buildDirectory, entry.name)),
  ].filter((file) => /\.(?:js|json|map|html|txt|rsc)$/.test(file));
  if (!files.length)
    throw new Error(
      "Run a production build before checking release artifacts.",
    );
  let secretMatches = 0;
  let privateReferences = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (secrets.some((secret) => content.includes(secret))) secretMatches += 1;
    if (file.endsWith(".nft.json")) {
      const trace = JSON.parse(content);
      if (
        !Array.isArray(trace.files) ||
        trace.files.some((name) => typeof name !== "string")
      )
        throw new Error("A release trace is invalid.");
      privateReferences += trace.files.filter((name) =>
        privateFiles.has(path.resolve(path.dirname(file), name)) ||
        /(?:^|[/\\])(?:\.local|test-results|playwright-report)(?:[/\\]|$)|(?:^|[/\\])\.env(?:$|\.)/.test(
          name,
        ),
      ).length;
    }
  }
  return { checked: files.length, secretMatches, privateReferences };
}

// Test imports never load the local credential file or execute the CLI.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (existsSync(".env")) process.loadEnvFile(".env");
    const result = await inspectRelease(".next", process.env);
    if (result.secretMatches || result.privateReferences) {
      console.error(
        "Release privacy check failed. Private content or runtime-data references exist in the build. Secret values were not printed.",
      );
      process.exitCode = 1;
    } else {
      console.log(
        `Release privacy check passed: ${result.checked} build files checked; no configured secrets or private runtime paths found.`,
      );
    }
  } catch {
    // Parser/filesystem exceptions can contain private input; never print them.
    console.error(
      "Release privacy check could not complete. Verify the production build and its trace files. Secret values were not printed.",
    );
    process.exitCode = 1;
  }
}
