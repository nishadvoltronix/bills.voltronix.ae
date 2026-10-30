import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
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
  const secrets = configuredSecrets(environment);
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
