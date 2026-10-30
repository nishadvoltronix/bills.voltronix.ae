# Existing Zoho business data on the production server

This handoff populates a clean production MySQL schema from the verified Zoho source cache. It transfers validated business data rather than cloning the development SQL database. Export, checking and import make no provider financial write and create no new invoice.

## Scope and prepared assets

The private bundle contains both companies' Books mirrors, complete originals and source evidence, CRM snapshots, canonical-job evidence, project associations and known cooldowns. Originals are checked against their recorded type, size and SHA256.

### Verified capture receipt

The successful capture was exported at **2026-10-30 10:37:25.150 UTC (14:37 Dubai)** from the local source without source-database writes or provider calls. Its original directory is `G:\bills.voltronix.ae\.local\production-transfer\zoho-source-20261030T103722604Z`.

| Captured item                 | Count |
| ----------------------------- | ----: |
| Companies                     |     2 |
| Books bill mirrors            | 4,674 |
| Original-document records     | 4,188 |
| Distinct original asset files | 4,155 |
| CRM snapshots                 | 6,049 |
| Reconstructable jobs          |   154 |
| Project-association proofs    |     9 |

Original records can share identical file bytes, so document-record and distinct-file counts differ. The exact `manifest.json` SHA256 is:

```text
678d26d3d0a4d91a7192e1d6e1709b8fb7e0b659a16a069b0082236260c1cda0
```

The complete dataset passed a disposable SQL restore rehearsal at **10:43:24 UTC**. All 4,674 bills, 4,188 original records, 6,049 CRM snapshots, 154 reconstructed jobs and nine stale proofs were restored. Every restored original's checksum matched; Books/CRM raw evidence, company isolation, cooldowns and proof expiry were preserved. Source counts were unchanged, no provider request was made, and the disposable database/files were cleaned up. The private receipt is `.local/production-transfer/rehearsal-1793357004015.json`. This verifies the full import on a disposable database, not an Ubuntu Docker deployment.

The importer maps sources to operational companies, reconstructs jobs from CRM records and the configured mapping, copies originals into the `invoices` volume and records a digest-pinned audit receipt. Local fixture bills/payments, seed users, sessions, password hashes, outgoing queues and live-posting authorizations are excluded. A fresh production Admin is provisioned separately.

Credential provenance metadata is included, but the old encrypted vault is not copied. Two organization-scoped Books grants and one CRM grant were prepared privately in `.env.production` after checking source/target fingerprints and access. The fresh production encryption key is retained. Authorized hosted refresh establishes encrypted credential records in the new vault; this transfer does not require the development encryption key.

Imported records are a local baseline, not current provider freshness. Incoming sources start pending or waiting for retained cooldowns and require initial reconciliation. All nine history proofs begin `STALE`, retain their source evidence and need hosted re-verification. Imported companies remain blocked from posting until their exact hosted Books destinations pass verification.

The original capture and receipt are retained under `G:\bills.voltronix.ae\.local\production-transfer\`. The private server handoff places that reviewed bundle at `deploy/.private/data-transfer/`, containing `manifest.json` and `originals/`. Its exact manifest SHA256 is already pinned in the prepared `deploy/.env.setup`.

The offline preparer `node deploy/prepare-transfer.mjs --manifest-sha256=<reviewed digest>` creates `.env.setup` and `.env.accounting` from the current runtime and the fresh Admin credential in `deploy/.private/setup-operator.json`. The permanent runtime retains enabled manual creation and matching incoming-operator credentials. Setup disables provider networking, incoming sync and all financial writes. Accounting enables only Books provider reads, disables financial writes and does not allow provisioning or restore. The private files passed offline configuration checks with no missing or invalid fields; this is configuration presence, not hosted acceptance. Do not substitute a different digest or password to bypass failed validation.

Transfer source and private assets separately. Source archives under `.local/deployment-release/` exclude the data bundle, database passwords, OAuth tokens, Admin password and encryption keys. The data bundle itself remains private because it contains real business records and originals.

## 1. Initialize the fresh database

Follow [MYSQL_HOSTING.md](MYSQL_HOSTING.md) to initialize MySQL, build images, migrate the schema and verify restricted runtime grants. Keep web and workers stopped. Import requires empty business tables; it refuses an existing populated target. Do not reset an operating database to satisfy this check.

Run from the extracted source root on Ubuntu, for example `/opt/voltronix-bills`. In addition to the MySQL runbook's permissions, allow container UID 1000 to read the separate setup/accounting files and immutable bundle:

```bash
sudo bash <<'PERMISSIONS'
set -euo pipefail
chown 1000:1000 deploy/.env.setup deploy/.env.accounting
chmod 0600 deploy/.env.setup deploy/.env.accounting
chown 1000:1000 deploy/.private/data-transfer deploy/.private/data-transfer/originals
chown 1000:1000 deploy/.private/data-transfer/manifest.json deploy/.private/data-transfer/originals/*
chmod 0500 deploy/.private/data-transfer deploy/.private/data-transfer/originals
chmod 0400 deploy/.private/data-transfer/manifest.json deploy/.private/data-transfer/originals/*
PERMISSIONS
```

Keep `setup-operator.json` private to the operator; it is not an app mount. Database root credentials and the CA private key remain protected separately.

## 2. Create the Admin and import once

Use separate functions for normal runtime and one-shot setup. The fourth file mounts the bundle read-only at `/run/zoho-transfer` and selects `.env.setup`. **Never use the transfer override with `up` or continuous workers.**

```bash
set -euo pipefail

dc() {
  sudo docker compose \
    -f deploy/compose.yaml \
    -f deploy/compose.mysql-ca.yaml \
    -f deploy/compose.mysql.yaml "$@"
}

dsetup() {
  sudo docker compose \
    -f deploy/compose.yaml \
    -f deploy/compose.mysql-ca.yaml \
    -f deploy/compose.mysql.yaml \
    -f deploy/compose.transfer.yaml "$@"
}

dsetup config --quiet
dsetup run --rm --no-deps web operator user:create
dsetup run --rm --no-deps web operator data:transfer prepare
dsetup run --rm --no-deps web operator data:transfer check
dsetup run --rm --no-deps web operator data:transfer import
```

Run `user:create` once. It creates the new Admin with an audit record and never replaces an existing password. `prepare` creates the configured operational companies, exact Books/CRM bindings and Admin memberships using local database writes; posting stays disabled.

`check` must report `SOURCE_CACHE_VERIFIED`. It checks the manifest digest, source identities, configuration/mapping, reconstructed fields and every original. It makes no provider request and does not establish destination readiness.

`import` reauthenticates the Admin, checks the fresh target and bindings, stages verified originals, then commits records and the audit receipt in a guarded transaction. Expect `RESTORED_PENDING_PROVIDER_CHECK`, matching counts, `providerRequests: 0`, `providerFinancialWrites: 0` and `financialWritesEnabled: false`. Retain the receipt privately. A second import is rejected because the destination is no longer empty.

If import reports `COMMIT_UNCONFIRMED`, preserve the database and staged files and inspect the audit receipt for that digest before recovery. A lost acknowledgment may leave a completed commit. Do not rerun provisioning/import or delete files based solely on a missing terminal success message. Resolve validation failures through their source/configuration cause, without editing the manifest or disabling guards.

## 3. Verify the hosted baseline and enable reads

Use the normal three-file configuration for running services:

```bash
dc up -d web proxy
dc run --rm --no-deps web check:sync
```

Log in with the new Admin credential. Check both companies, representative Books bills, originals, CRM records and reconstructed jobs against the receipt. No native fixture invoice or outgoing operation should have been copied. Verify the invoice volume before recreating services. Readiness will still report unverified operational destinations until the separate accounting step completes. The transfer creates no local suppliers: `REAL_VENDOR_REQUIRED` or `VENDOR_MAPPING_REQUIRED` clears after a real supplier is selected and resolved for the company, or explicitly configured through `books:suppliers`.

Follow [the Cloudflare handoff](../deploy/README.md#cloudflare-tunnel-and-hosted-login) and register hosted callbacks for future reauthorization. Scoped bootstrap grants are prepared, but revoked grants or changed client/source identities still need correction. Once normal-runtime source credentials and memberships are ready:

```bash
dc up -d incoming job-history
dc logs --tail=50 incoming job-history
```

Allow initial reconciliation and history-proof re-verification to finish. Incoming checks run 60 seconds after completed passes. Known cooldowns survive transfer; waiting Contracting metadata is not a reason to clear backoff or force requests. Confirm advancing source timestamps and current history proofs before calling hosted read acceptance complete. Retire duplicate local polling during final manual cutover.

## 4. Verify destinations and activate manual creation

The runtime is prepared with `ZOHO_BOOKS_WRITE_ENABLED=true` and `ZOHO_BOOKS_LIVE_ENABLED=true`, while `ALLOW_PRODUCTION_ACCOUNTING_WRITES=false`. Prepared profiles use the organizations' AED base currency and require selection of the actual Books expense account and tax on every bill line. The supplier is selected from the same Books organization at entry; no global expense/tax defaults need to be invented. These bill checks do not replace exact hosted organization, currency and destination verification.

The setup and accounting environments always keep all three financial-write flags `false`, even with an enabled runtime. Follow [the separate accounting activation command](../deploy/README.md#accounting-review-and-outgoing-activation): stop incoming/history/outgoing workers, run `books:activate` through `compose.accounting.yaml`, and require every operational destination to report `VERIFIED` before starting outgoing sync. Respect `WAITING_SOURCE` retry times and `WAITING_QUOTA` cooldowns, including Contracting's retained hold. This verification makes provider reads and local audit/configuration writes; it does not post a bill. Use the next genuine new invoice for confirmed local-plus-Zoho posting; do not enter existing invoices again.

Back up the new production database, originals and its own encryption key together. Preserve the transfer receipt for provenance; use verified production backups for later recovery. Local tests do not replace Ubuntu Docker startup, migration/import, TLS, storage, reboot and hosted acceptance. Docker execution was unavailable on the preparation machine.
