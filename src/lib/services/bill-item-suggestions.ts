import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { requireCompanyAccess } from "@/lib/company";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { canCreateBill } from "@/lib/permissions";
import { assertCurrentBillReader } from "./bill-ownership";

export type BillItemSuggestions = {
  companyId: string;
  jobId: string;
  suggestions: { description: string }[];
};

const inputSchema = z.object({
  companyId: z.string().trim().min(1).max(100),
  jobId: z.string().trim().min(1).max(100),
  q: z.string().trim().min(1).max(500),
}).strict();

async function assertContext(actor: Actor, companyId: string, jobId: string) {
  await assertCurrentBillReader(actor);
  await requireCompanyAccess(actor, companyId);
  if (!await db.job.findFirst({ where: { id: jobId, companyId }, select: { id: true } }))
    throw new HttpError(404, "Job not found.");
}

/** Read-only native history. A shared job never grants access to another user's items. */
export async function getBillItemSuggestions(actor: Actor, params: URLSearchParams): Promise<BillItemSuggestions> {
  if (!canCreateBill(actor)) throw new HttpError(403, "Your role cannot enter bills.");
  const allowed = ["companyId", "jobId", "q"];
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1))
    throw new HttpError(422, "Use one company, job and item search phrase.");
  const { companyId, jobId, q } = inputSchema.parse(Object.fromEntries(params));
  await assertContext(actor, companyId, jobId);

  // Search before ranking/limiting: repeated recent descriptions cannot hide
  // older matching items. LOCATE treats %, _ and backslashes as literal text.
  // Only ten descriptions cross the database boundary; no financial fields do.
  const rows = await db.$queryRaw<{ description: string }[]>(Prisma.sql`
    SELECT ranked.description FROM (
      SELECT TRIM(line.description) AS description,
        bill.updatedAt, bill.createdAt, bill.id AS billId, line.id AS lineId,
        ROW_NUMBER() OVER (
          PARTITION BY LOWER(TRIM(line.description))
          ORDER BY bill.updatedAt DESC, bill.createdAt DESC, bill.id DESC, line.id DESC
        ) AS descriptionRank
      FROM BillLine AS line
      INNER JOIN Bill AS bill ON bill.id = line.billId
      WHERE bill.companyId = ${companyId} AND bill.jobId = ${jobId}
        ${actor.role === "ADMIN" ? Prisma.empty : Prisma.sql`AND bill.createdById = ${actor.id}`}
        AND bill.status IN ('DRAFT', 'READY', 'APPROVED', 'PENDING_APPROVAL')
        AND CHAR_LENGTH(TRIM(line.description)) BETWEEN 1 AND 500
        AND LOCATE(LOWER(${q}), LOWER(line.description)) > 0
    ) AS ranked
    WHERE ranked.descriptionRank = 1
    ORDER BY ranked.updatedAt DESC, ranked.createdAt DESC, ranked.billId DESC, ranked.lineId DESC
    LIMIT 10
  `);

  await assertContext(actor, companyId, jobId);
  return { companyId, jobId, suggestions: rows.map(({ description }) => ({ description })) };
}
