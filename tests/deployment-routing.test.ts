import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("container replacement routing", () => {
  it("refreshes the Books application's upstream address through Docker DNS without restarting nginx", () => {
    const config = readFileSync("deploy/nginx.conf", "utf8").replace(/#.*$/gm, "");
    const upstream = config.match(/upstream\s+bills\s*\{([^}]+)\}/)?.[1];
    expect(upstream).toBeDefined();
    // resolve requires both a DNS resolver and a shared upstream zone. Checking
    // the complete configuration prevents a syntactically valid static upstream
    // from silently retaining a removed web container's IP after deployment.
    expect(config).toMatch(/resolver\s+127\.0\.0\.11\s+[^;]*valid=5s[^;]*;/);
    expect(config).toMatch(/resolver_timeout\s+5s\s*;/);
    expect(upstream).toMatch(/zone\s+\S+\s+\d+[kKmM]\s*;/);
    expect(upstream).toMatch(/server\s+web:3000\s+resolve\s*;/);
    expect(config).toMatch(/proxy_pass\s+http:\/\/bills\s*;/);
  });
});
