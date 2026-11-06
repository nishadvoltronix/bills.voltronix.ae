import "server-only";
import { db } from "@/lib/db";
import { IntegrationError, type ZohoConfig } from "./config";
import { buildPaymentPayload, paymentSourceHash, validatePaymentBill } from "./books-payments";
import { accessToken } from "./oauth";
import { ZohoTransport, type ProductionWriteRequest } from "./transport";

declare const paymentCapability: unique symbol;
export type PaymentWriteCapability = { readonly [paymentCapability]: true };
const permits = new WeakMap<object, { jobId: string; leaseToken: string; consumed: boolean }>();
const denied = () => new IntegrationError("PAYMENT_WRITE_PERMISSION_REQUIRED", "Only the exact current saved payment operation may record a Books payment.", "BLOCKED");
export function paymentWriteCapability(jobId: string, leaseToken: string): PaymentWriteCapability {
  const capability = Object.freeze({}) as PaymentWriteCapability;
  permits.set(capability, { jobId, leaseToken, consumed: false });
  return capability;
}
export async function assertPaymentBooksWrite(capability: PaymentWriteCapability, config: ZohoConfig, request?: ProductionWriteRequest) {
  const permit = permits.get(capability);
  if (!permit || permit.consumed || config.target !== "ZOHO" || request?.path !== "/books/v3/vendorpayments" ||
    (request.method ?? "POST") !== "POST" || request.form) throw denied();
  const job = await db.paymentBooksSync.findUnique({ where: { id: permit.jobId } });
  if (!job || job.status !== "PROCESSING" || job.leaseToken !== permit.leaseToken || !job.leaseUntil || job.leaseUntil <= new Date() ||
    !job.submittedAt || job.externalPaymentId || !job.externalBillId || config.organizationId !== job.organizationId || config.dataCenter !== job.dataCenter || config.environment !== job.environment) throw denied();
  const { assertPaymentBooksSource, assertPaymentAccount } = await import("@/lib/services/payment-books-sync");
  const source = await assertPaymentBooksSource(job, config);
  if (source.externalBillId !== job.externalBillId || paymentSourceHash(request.body) !== paymentSourceHash(buildPaymentPayload(source.snapshot, job.externalBillId))) throw denied();
  if (await db.integrationJob.count({ where: { billId: job.billId, target: "ZOHO", OR: [
    { status: "PROCESSING" },
    { operation: { not: "ATTACH_DOCUMENT" }, OR: [{ status: "UNKNOWN" }, { needsReconciliation: true, status: { not: "SUCCEEDED" } }] },
  ] } })) throw denied();
  const reader = new ZohoTransport(config, () => accessToken(config));
  await assertPaymentAccount(config, source.snapshot.payment.paidThroughAccountId, source.snapshot.bill.currency, reader);
  validatePaymentBill(await reader.request(`/books/v3/bills/${job.externalBillId}`, { method: "GET" }), source.snapshot, job.externalBillId);
  await assertPaymentBooksSource(job, config);
  if (!await db.paymentBooksSync.findFirst({ where: { id: job.id, status: "PROCESSING", leaseToken: permit.leaseToken, leaseUntil: { gt: new Date() },
    sourceHash: job.sourceHash, submittedAt: { not: null }, externalPaymentId: null, externalBillId: job.externalBillId }, select: { id: true } })) throw denied();
}
export function consumePaymentBooksWrite(capability: PaymentWriteCapability) {
  const permit = permits.get(capability);
  if (!permit || permit.consumed) throw denied();
  permit.consumed = true;
}
export function paymentWriteWasSubmitted(capability: PaymentWriteCapability) {
  return permits.get(capability)?.consumed === true;
}
