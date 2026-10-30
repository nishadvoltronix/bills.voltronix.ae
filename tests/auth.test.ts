import { describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/password";
import { HttpError, readJson, sameOrigin } from "@/lib/http";
import { detectDocumentType } from "@/lib/services/documents";
import {
  IntegrationNotConfiguredError,
  ocrProvider,
  syncProvider,
} from "@/lib/services/integrations";

// Document signature tests do not need a database connection.
vi.mock("@/lib/db", () => ({ db: {} }));

describe("password hashing", () => {
  it("uses salted scrypt hashes and verifies only the correct password", async () => {
    const hash = await hashPassword("Fictional-test-only-password-46");
    expect(hash).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(hash).not.toContain("Fictional");
    expect(await verifyPassword("Fictional-test-only-password-46", hash)).toBe(
      true,
    );
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
  it("rejects malformed hashes and prevents attacker-selected scrypt costs", async () => {
    expect(await verifyPassword("password", "plain-text-password")).toBe(false);
    expect(
      await verifyPassword(
        "password",
        `scrypt$999999999$8$3$${"a".repeat(32)}$${"a".repeat(128)}`,
      ),
    ).toBe(false);
    await expect(hashPassword("short")).rejects.toThrow("12 to 128");
  });
});

describe("request security", () => {
  it("requires the configured origin for writes, including login", () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = "http://127.0.0.1:3000";
    expect(() =>
      sameOrigin(
        new Request("http://127.0.0.1:3000/api/bills", {
          headers: { origin: "http://127.0.0.1:3000" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      sameOrigin(
        new Request("http://127.0.0.1:3000/api/bills", {
          headers: { origin: "https://attacker.example" },
        }),
      ),
    ).toThrow(HttpError);
    expect(() =>
      sameOrigin(new Request("http://127.0.0.1:3000/api/bills")),
    ).toThrow(HttpError);
    if (previous === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previous;
  });
  it("bounds bodies even without a content-length header", async () => {
    await expect(
      readJson(
        new Request("http://local.test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ long: "x".repeat(100) }),
        }),
        20,
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readJson(
        new Request("http://local.test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{broken",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("inspects document signatures instead of trusting extensions", () => {
    expect(detectDocumentType(Buffer.from("%PDF-1.4\ncontent")).mimeType).toBe(
      "application/pdf",
    );
    expect(
      detectDocumentType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        .mimeType,
    ).toBe("image/png");
    expect(() =>
      detectDocumentType(Buffer.from("<svg><script>alert(1)</script></svg>")),
    ).toThrow(HttpError);
  });
});

describe("disconnected integration adapters", () => {
  it("never fabricates OCR output or synchronization success", async () => {
    await expect(
      ocrProvider.extract({
        bytes: new Uint8Array(),
        mimeType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    for (const provider of ["ZOHO", "CRM"] as const) {
      await expect(
        syncProvider(provider).createApprovedBill({
          internalBillId: "test",
          approvedVersion: 1,
          idempotencyKey: "test:1",
        }),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      await expect(
        syncProvider(provider).reconcile("test"),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    }
  });
});
