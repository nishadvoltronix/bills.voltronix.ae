import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertMySqlTestDatabase } from "./company-fixtures";

// Runtime/production rejection is covered separately. All writes here use only
// the disposable database verified below, with every provider disabled.
vi.mock("@/lib/integrations/config", async (original) => ({
  ...(await original<typeof import("@/lib/integrations/config")>()),
  productionBooksRuntimeReady: () => true,
}));
import { prepareManualCompany } from "@/lib/services/manual-company";

const tag = randomUUID().slice(0, 8);
let operator: Actor, staff: Actor, outsider: Actor;
const payload = {
  companyName: `Fictional Manual Company ${tag}`,
  reference: "Fictional owner assignment evidence",
};
let companyId: string;

beforeAll(async () => {
  assertMySqlTestDatabase();
  [operator, staff, outsider] = await Promise.all(
    (["ADMIN", "ACCOUNTS", "ADMIN"] as const).map((role, index) =>
      db.user.create({
        data: {
          email: `manual-${tag}-${index}@example.invalid`,
          name: `Fictional manual operator ${index}`,
          role,
          passwordHash: "disabled-test-login",
        },
      }),
    ),
  );
});
beforeEach(() => {
  vi.stubEnv("ALLOW_MANUAL_COMPANY_SETUP", "true");
  vi.stubEnv("ZOHO_BOOKS_LIVE_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db.$disconnect();
});

describe("manual company provisioning in MySQL", () => {
  it("bootstraps an empty company with owner and staff membership, without provider destinations", async () => {
    const result = await prepareManualCompany(operator, {
      ...payload,
      memberEmail: staff.email,
    });
    companyId = result.companyId;
    expect(result).toMatchObject({
      created: true,
      memberAssigned: true,
      providerRequests: 0,
      financialWritesEnabled: false,
    });
    const company = await db.company.findUniqueOrThrow({
      where: { id: companyId },
      include: { memberships: true, integrationDestinations: true },
    });
    expect(company).toMatchObject({
      active: true,
      isDemo: false,
      liveAccountingEnabled: false,
      name: payload.companyName,
    });
    expect(company.memberships.map((member) => member.userId).sort()).toEqual(
      [operator.id, staff.id].sort(),
    );
    expect(company.integrationDestinations).toEqual([]);
    const audits = await db.auditLog.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((event) => event.action).sort()).toEqual([
      "COMPANY_MEMBERSHIP_GRANTED",
      "MANUAL_COMPANY_PREPARED",
    ]);
    expect(audits.every((event) => event.actorId === operator.id)).toBe(true);
    expect(audits[0].details).toMatchObject({
      reference: payload.reference,
      source: "reauthenticated_operator",
    });
  });
  it("repeated setup is idempotent and does not duplicate audit records", async () => {
    const result = await prepareManualCompany(operator, {
      ...payload,
      memberEmail: staff.email,
    });
    expect(result).toMatchObject({
      companyId,
      created: false,
      memberAssigned: false,
    });
    expect(await db.auditLog.count({ where: { companyId } })).toBe(2);
  });
  it("refuses an outsider administrator and an actor whose database role was downgraded", async () => {
    await expect(
      prepareManualCompany(outsider, {
        ...payload,
        memberEmail: outsider.email,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      prepareManualCompany({ ...staff, role: "ADMIN" }, payload),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db.userCompanyMembership.count({
        where: { companyId, userId: outsider.id },
      }),
    ).toBe(0);
  });
  it("audits reactivation separately and leaves the user's global role unchanged", async () => {
    await db.userCompanyMembership.update({
      where: { userId_companyId: { userId: staff.id, companyId } },
      data: { active: false },
    });
    expect(
      (
        await prepareManualCompany(operator, {
          ...payload,
          memberEmail: staff.email,
        })
      ).memberAssigned,
    ).toBe(true);
    const event = await db.auditLog.findFirstOrThrow({
      where: {
        companyId,
        entityId: staff.id,
        action: "COMPANY_MEMBERSHIP_GRANTED",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(event.details).toMatchObject({
      previousActive: false,
      active: true,
    });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: staff.id } })).role,
    ).toBe("ACCOUNTS");
  });
  it("does not create a company when its requested member is missing or inactive", async () => {
    const companyName = `Fictional Uncommitted Company ${tag}`;
    await expect(
      prepareManualCompany(operator, {
        ...payload,
        companyName,
        memberEmail: "missing@example.invalid",
      }),
    ).rejects.toMatchObject({ status: 422 });
    await db.user.update({
      where: { id: outsider.id },
      data: { active: false },
    });
    await expect(
      prepareManualCompany(operator, {
        ...payload,
        companyName,
        memberEmail: outsider.email,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await db.company.count({ where: { name: companyName } })).toBe(0);
  });
  it("preserves an existing company with the same name instead of creating a parallel ledger", async () => {
    const other = await db.company.create({
      data: { name: `Fictional Existing Company ${tag}`, isDemo: false },
    });
    await expect(
      prepareManualCompany(operator, { ...payload, companyName: other.name }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.company.count({ where: { name: other.name } })).toBe(1);
  });
  it("does not repurpose a company once live accounting has been enabled", async () => {
    await db.company.update({
      where: { id: companyId },
      data: { liveAccountingEnabled: true },
    });
    await expect(prepareManualCompany(operator, payload)).rejects.toMatchObject(
      { status: 409 },
    );
    expect(
      (await db.company.findUniqueOrThrow({ where: { id: companyId } }))
        .liveAccountingEnabled,
    ).toBe(true);
  });
});
