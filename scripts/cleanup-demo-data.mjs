import mysql from "mysql2/promise";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { openLocalAdmin, verifyLocalServer } from "./lib/mysql-local-admin.mjs";

// This is deliberately a one-time cleanup of the seed fixtures, not a generic
// purge or a predicate such as isDemo=true (real connection-check data uses it).
const ROOT = path.resolve(import.meta.dirname, "..");
const COMPANY_IDS = ["demo-company-secondary", "demo-company-voltronix"];
const VENDOR_IDS = [
  "demo-vendor-electrical",
  "demo-vendor-equipment",
  "demo-vendor-materials",
];
const JOB_IDS = [
  "demo-job-marina",
  "demo-job-retail",
  "demo-job-unvalued",
  "demo-job-warehouse",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const companyPredicate =
  "companyId IN ('demo-company-secondary','demo-company-voltronix')";
const billPredicate = `billId IN (SELECT id FROM Bill WHERE ${companyPredicate})`;
const batchPredicate = `batchId IN (SELECT id FROM OcrBatch WHERE ${companyPredicate})`;
const statements = {
  Company: `SELECT * FROM Company WHERE id IN ('demo-company-secondary','demo-company-voltronix') ORDER BY id`,
  Bill: `SELECT * FROM Bill WHERE ${companyPredicate} ORDER BY id`,
  BillLine: `SELECT * FROM BillLine WHERE ${billPredicate} ORDER BY id`,
  Payment: `SELECT * FROM Payment WHERE ${billPredicate} ORDER BY id`,
  Document: `SELECT * FROM Document WHERE ${billPredicate} ORDER BY id`,
  SyncRecord: `SELECT * FROM SyncRecord WHERE ${billPredicate} ORDER BY id`,
  IntegrationJob: `SELECT * FROM IntegrationJob WHERE ${billPredicate} ORDER BY id`,
  LiveSyncAuthorization: `SELECT * FROM LiveSyncAuthorization WHERE ${companyPredicate} ORDER BY id`,
  OcrBatch: `SELECT * FROM OcrBatch WHERE ${companyPredicate} ORDER BY id`,
  OcrDocument: `SELECT * FROM OcrDocument WHERE ${batchPredicate} ORDER BY id`,
  Vendor: `SELECT * FROM Vendor WHERE ${companyPredicate} ORDER BY id`,
  VendorBooksMapping: `SELECT * FROM VendorBooksMapping WHERE vendorId IN (SELECT id FROM Vendor WHERE ${companyPredicate}) ORDER BY id`,
  Job: `SELECT * FROM Job WHERE ${companyPredicate} ORDER BY id`,
  OcrTemplate: `SELECT * FROM OcrTemplate WHERE vendorId IN (SELECT id FROM Vendor WHERE ${companyPredicate}) ORDER BY id`,
  ScannerSource: `SELECT * FROM ScannerSource WHERE ${companyPredicate} ORDER BY id`,
  CompanyCrmSource: `SELECT * FROM CompanyCrmSource WHERE ${companyPredicate} ORDER BY companyId`,
  CompanyIntegrationDestination: `SELECT * FROM CompanyIntegrationDestination WHERE ${companyPredicate} ORDER BY companyId,target,organizationId,dataCenter,environment`,
  UserCompanyMembership: `SELECT * FROM UserCompanyMembership WHERE ${companyPredicate} ORDER BY companyId,userId`,
};

function privatePath(value, exists = true) {
  const resolved = path.resolve(ROOT, value);
  const privateRoot = path.join(ROOT, ".local");
  requireThat(
    resolved.toLowerCase().startsWith(privateRoot.toLowerCase() + path.sep),
    "Only workspace-private .local paths are permitted.",
  );
  let ancestor = resolved;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  requireThat(
    !lstatSync(ancestor).isSymbolicLink() &&
      realpathSync(ancestor).toLowerCase() === ancestor.toLowerCase(),
    "Redirected private paths are refused.",
  );
  if (exists)
    requireThat(
      existsSync(resolved) &&
        !lstatSync(resolved).isSymbolicLink() &&
        realpathSync(resolved).toLowerCase() === resolved.toLowerCase(),
      "An existing unredirected private path is required.",
    );
  return resolved;
}

function assertRuntime() {
  requireThat(
    ROOT.toLowerCase() === "g:\\bills.voltronix.ae" &&
      process.cwd().toLowerCase() === ROOT.toLowerCase(),
    "Cleanup is restricted to the known billing workspace.",
  );
  const target = new URL(process.env.DATABASE_URL || "mysql://invalid");
  requireThat(
    process.env.APP_ENV === "development" &&
      process.env.NODE_ENV !== "production" &&
      target.protocol === "mysql:" &&
      target.hostname === "127.0.0.1" &&
      target.port === "3308" &&
      target.pathname === "/voltronix_billing_dev" &&
      target.username === "voltronix_billing_app" &&
      !target.search &&
      !target.hash,
    "Cleanup requires the exact local development database and application account.",
  );
  return privatePath(process.env.UPLOAD_DIR || ".local/uploads");
}

async function inventory(connection, directory, lock = false) {
  const rows = {};
  for (const [table, sql] of Object.entries(statements))
    [rows[table]] = await connection.query(sql + (lock ? " FOR UPDATE" : ""));
  requireThat(
    rows.Company.length === 2 &&
      rows.Company.every(
        (row) =>
          row.isDemo === 1 &&
          row.liveAccountingEnabled === 0 &&
          row.name.startsWith("[DEMO] Fictional Company "),
      ),
    "Known seeded company identities changed.",
  );
  requireThat(
    rows.Bill.every(
      (row) =>
        /^DEMO-/.test(row.invoiceNumber) &&
        VENDOR_IDS.includes(row.vendorId) &&
        JOB_IDS.includes(row.jobId),
    ),
    "A non-fixture bill exists in a seeded company; cleanup refused.",
  );
  requireThat(
    rows.Vendor.every(
      (row) =>
        VENDOR_IDS.includes(row.id) &&
        row.isDemo === 1 &&
        row.externalZohoId === null &&
        row.externalCrmId === null,
    ),
    "A non-fixture or provider-linked supplier would be affected.",
  );
  requireThat(
    rows.Job.every(
      (row) =>
        JOB_IDS.includes(row.id) &&
        row.isDemo === 1 &&
        row.externalCrmId === null,
    ),
    "A non-fixture or provider-linked job would be affected.",
  );
  requireThat(
    rows.SyncRecord.every(
      (row) =>
        ["NOT_CONFIGURED", "FAILED"].includes(row.status) &&
        row.externalId === null &&
        row.organizationId === null &&
        row.attempts === 0 &&
        row.lastSyncedAt === null,
    ),
    "External sync evidence exists; manual reconciliation is required before cleanup.",
  );
  for (const table of [
    "IntegrationJob",
    "LiveSyncAuthorization",
    "VendorBooksMapping",
    "OcrTemplate",
    "ScannerSource",
    "CompanyCrmSource",
  ])
    requireThat(
      rows[table].length === 0,
      `Unexpected ${table} evidence exists; cleanup refused.`,
    );
  const billIds = new Set(rows.Bill.map((row) => row.id));
  requireThat(
    rows.OcrDocument.every(
      (row) =>
        /^DEMO-/i.test(row.fileName) &&
        row.status === "POSTED" &&
        billIds.has(row.billId) &&
        row.leaseToken === null &&
        row.leaseUntil === null,
    ),
    "An unrecognized or active OCR item would be affected.",
  );
  requireThat(
    rows.Document.every((row) => /^DEMO-/i.test(row.fileName)),
    "An unrecognized document would be affected.",
  );
  requireThat(
    rows.CompanyIntegrationDestination.every(
      (row) =>
        row.target === "ZOHO" &&
        row.organizationId ===
          (row.companyId === "demo-company-voltronix" ? "100" : "200") &&
        row.dataCenter === "US" &&
        row.environment === "sandbox" &&
        row.liveEnabled === 0 &&
        row.verifiedAt === null &&
        row.verificationReference === null &&
        row.verifiedConfigurationHash === null,
    ),
    "A real or verified destination would be affected.",
  );
  const files = new Map();
  for (const row of [...rows.Document, ...rows.OcrDocument]) {
    requireThat(
      /^[a-f0-9-]{36}\.(pdf|png|jpg)$/.test(row.storageKey),
      "An unsafe document storage key was refused.",
    );
    const filename = privatePath(path.join(directory, row.storageKey));
    requireThat(
      lstatSync(filename).isFile(),
      "A document is not a regular file.",
    );
    const bytes = readFileSync(filename);
    requireThat(
      bytes.length === row.byteSize && hash(bytes) === row.sha256,
      "Document size or hash verification failed.",
    );
    const metadata = {
      storageKey: row.storageKey,
      byteSize: row.byteSize,
      sha256: row.sha256,
    };
    requireThat(
      !files.has(row.storageKey) ||
        digest(files.get(row.storageKey)) === digest(metadata),
      "Conflicting shared document metadata.",
    );
    files.set(row.storageKey, metadata);
  }
  const protectedReferences = [
    ...(
      await connection.query(
        `SELECT storageKey FROM Document WHERE NOT (${billPredicate})`,
      )
    )[0],
    ...(
      await connection.query(
        `SELECT storageKey FROM OcrDocument WHERE NOT (${batchPredicate})`,
      )
    )[0],
  ];
  requireThat(
    protectedReferences.every((row) => !files.has(row.storageKey)),
    "A fixture document is also referenced by preserved data.",
  );
  const scannerReferences = (
    await connection.query(
      `SELECT COUNT(*) n FROM ScannerImport WHERE documentId IN (SELECT id FROM Document WHERE ${billPredicate}) OR ocrDocumentId IN (SELECT id FROM OcrDocument WHERE ${batchPredicate})`,
    )
  )[0][0];
  requireThat(
    Number(scannerReferences.n) === 0,
    "Scanner evidence exists; cleanup refused.",
  );
  return {
    rows,
    files: [...files.values()].sort((a, b) =>
      a.storageKey.localeCompare(b.storageKey),
    ),
  };
}

async function protectedDigest(connection) {
  // Credentials are compared in memory only and never enter the cleanup plan.
  const protectedRows = {};
  for (const table of [
    "User",
    "IntegrationCredential",
    "IntegrationOAuthState",
    "AuditLog",
    "HubUserBinding",
    "CompanyCrmSource",
  ])
    [protectedRows[table]] = await connection.query(
      `SELECT * FROM ${table} ORDER BY 1,2`,
    );
  for (const table of [
    "Company",
    "Job",
    "Vendor",
    "UserCompanyMembership",
    "CompanyIntegrationDestination",
  ])
    [protectedRows[table]] = await connection.query(
      `SELECT * FROM ${table} WHERE ${table === "Company" ? "id" : "companyId"} NOT IN ('demo-company-secondary','demo-company-voltronix') ORDER BY 1,2`,
    );
  return digest(protectedRows);
}

async function main() {
  const [mode, ...argv] = process.argv.slice(2);
  const args = Object.fromEntries(
    argv.map((arg) => {
      const split = arg.indexOf("=");
      requireThat(
        arg.startsWith("--") && split > 2,
        "Arguments require --name=value syntax.",
      );
      return [arg.slice(2, split), arg.slice(split + 1)];
    }),
  );
  requireThat(mode === "plan" || mode === "apply", "Choose plan or apply.");
  const directory = assertRuntime();
  const context = await openLocalAdmin();
  await context.connection.end();
  const connection = await mysql.createConnection({
    host: "127.0.0.1",
    port: 3308,
    user: context.settings.application.user,
    password: context.settings.application.password,
    database: "voltronix_billing_dev",
    timezone: "Z",
    charset: "utf8mb4",
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  });
  let committed = false;
  let transaction = false;
  let receiptPath;
  let receipt;
  try {
    await verifyLocalServer({ ...context, connection });
    if (mode === "plan") {
      const snapshot = await inventory(connection, directory);
      const plan = {
        format: 1,
        database: "voltronix_billing_dev",
        serverUuid: context.manifest.serverUuid,
        createdAt: new Date().toISOString(),
        uploadDirectory: directory,
        companyIds: COMPANY_IDS,
        stateSha256: digest(snapshot),
        counts: Object.fromEntries(
          Object.entries(snapshot.rows).map(([name, rows]) => [
            name,
            rows.length,
          ]),
        ),
        files: snapshot.files,
        removeIds: Object.fromEntries(
          Object.entries(snapshot.rows)
            .filter(([, rows]) => rows.every((row) => "id" in row))
            .map(([name, rows]) => [name, rows.map((row) => row.id)]),
        ),
        companyAction:
          "Deactivate both seeded companies; retain every audit record and authentication grant.",
      };
      const output = privatePath(
        args.output || ".local/cleanup-demo-plan.json",
        false,
      );
      mkdirSync(path.dirname(output), { recursive: true });
      const bytes = Buffer.from(JSON.stringify(plan, null, 2) + "\n");
      writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
      console.log(
        JSON.stringify({
          mode,
          output,
          sha256: hash(bytes),
          counts: plan.counts,
          uniqueFiles: plan.files.length,
          bytes: plan.files.reduce((sum, file) => sum + file.byteSize, 0),
        }),
      );
      return;
    }
    const planPath = privatePath(args.plan || "");
    const planBytes = readFileSync(planPath);
    requireThat(
      /^[a-f0-9]{64}$/.test(args["plan-sha256"] || "") &&
        hash(planBytes) === args["plan-sha256"],
      "Reviewed plan hash is required and must match.",
    );
    const plan = JSON.parse(planBytes.toString("utf8"));
    requireThat(
      plan.format === 1 &&
        plan.database === "voltronix_billing_dev" &&
        plan.serverUuid === context.manifest.serverUuid &&
        plan.uploadDirectory === directory,
      "Reviewed cleanup plan targets a different instance or document directory.",
    );
    const backupPath = privatePath(args.backup || "");
    requireThat(
      lstatSync(backupPath).isFile() &&
        lstatSync(backupPath).size > 0 &&
        /^[a-f0-9]{64}$/.test(args["backup-sha256"] || "") &&
        hash(readFileSync(backupPath)) === args["backup-sha256"],
      "A separately completed backup file and matching SHA-256 are required.",
    );
    const quarantine = privatePath(args.quarantine || "", false);
    requireThat(
      !existsSync(quarantine) &&
        !quarantine
          .toLowerCase()
          .startsWith(directory.toLowerCase() + path.sep) &&
        quarantine.toLowerCase() !== directory.toLowerCase(),
      "Quarantine must be a new private directory separate from active uploads.",
    );
    mkdirSync(quarantine, { recursive: true });
    receiptPath = path.join(quarantine, "cleanup-receipt.json");
    receipt = {
      id: randomUUID(),
      database: plan.database,
      planSha256: args["plan-sha256"],
      backupPath,
      backupSha256: args["backup-sha256"],
      startedAt: new Date().toISOString(),
      committed: false,
      counts: plan.counts,
      quarantined: [],
      pending: plan.files.map((file) => file.storageKey),
    };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await connection.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await connection.beginTransaction();
    transaction = true;
    const snapshot = await inventory(connection, directory, true);
    requireThat(
      digest(snapshot) === plan.stateSha256,
      "Fixture data changed since the reviewed plan; nothing was deleted.",
    );
    const preserved = await protectedDigest(connection);
    for (const [table, predicate] of [
      ["OcrDocument", batchPredicate],
      ["OcrBatch", companyPredicate],
      ["Document", billPredicate],
      ["Payment", billPredicate],
      ["SyncRecord", billPredicate],
      ["BillLine", billPredicate],
      ["Bill", companyPredicate],
      ["Vendor", companyPredicate],
      ["Job", companyPredicate],
      ["CompanyIntegrationDestination", companyPredicate],
      ["UserCompanyMembership", companyPredicate],
    ]) {
      const [result] = await connection.query(
        `DELETE FROM ${table} WHERE ${predicate}`,
      );
      requireThat(
        result.affectedRows === snapshot.rows[table].length,
        `Concurrent ${table} change detected; transaction will roll back.`,
      );
    }
    await connection.query(
      "UPDATE Company SET active=0 WHERE id IN ('demo-company-secondary','demo-company-voltronix') AND isDemo=1 AND liveAccountingEnabled=0",
    );
    requireThat(
      (await protectedDigest(connection)) === preserved,
      "Preserved authentication, audit, or real records changed; transaction will roll back.",
    );
    await connection.commit();
    committed = true;
    transaction = false;
    receipt.committed = true;
    receipt.committedAt = new Date().toISOString();
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    for (const file of plan.files) {
      const source = privatePath(path.join(directory, file.storageKey));
      const destination = privatePath(
        path.join(quarantine, file.storageKey),
        false,
      );
      requireThat(
        !existsSync(destination) && hash(readFileSync(source)) === file.sha256,
        "Quarantine file verification failed; remaining files remain in active storage.",
      );
      renameSync(source, destination);
      receipt.quarantined.push(file.storageKey);
      receipt.pending = receipt.pending.filter(
        (key) => key !== file.storageKey,
      );
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    }
    receipt.completedAt = new Date().toISOString();
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(
      JSON.stringify({
        mode,
        committed,
        receiptPath,
        deleted: Object.fromEntries(
          Object.entries(plan.counts).filter(([table]) => table !== "Company"),
        ),
        companiesDeactivated: 2,
        documentsQuarantined: receipt.quarantined.length,
        preservedAuthenticationAndAudits: true,
      }),
    );
  } catch (error) {
    if (transaction) await connection.rollback();
    if (receiptPath && receipt) {
      receipt.failure = error.message;
      receipt.committed = committed;
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    }
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  // Driver failures may contain SQL details. Only our known validation messages
  // are safe; a code identifies database failures without printing credentials.
  console.error(
    error.code
      ? `Fixture cleanup failed (${error.code}); inspect the private receipt.`
      : error.message,
  );
  process.exitCode = 1;
});
