> Historical PostgreSQL runbook retained verbatim below. It is not the active MySQL deployment procedure. See [current deployment status](../DEPLOYMENT.md).

# Deployment and recovery runbook

This manual runbook does not authorize deployment, DNS changes, production migrations or live accounting operations. The application needs a long-running Node.js server, PostgreSQL, persistent private document storage and supervised workers for enabled automation. Static-only hosting is insufficient; ephemeral storage is unsuitable for the current filesystem document adapter.

The [integration readiness review](INTEGRATION_READINESS.md) records the latest local checks and the exact nonproduction test sequence. Books production writes are unsupported in this release. Nonproduction tests require an independently verified target, explicit test mode, an expiring operator attestation and successful per-POST organization checks. No credential, environment label or successful build grants release approval.

## Validate the release

Use the locked dependencies, supported Node runtime and isolated local PostgreSQL with fictional data:

```text
npm ci
npm run db:generate
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run build
npm run check:release
npm audit
```

Keep `.env`, `.local`, database files, invoice uploads, test reports and credentials out of release artifacts. Build for the target OS. Preserve source, lockfile, migrations and the previous release. Actual results are recorded in `IMPLEMENTATION_STATUS.md`; rerun checks after material changes.

Migration `202610270006_books_organizations` changes OAuth credential identity to product plus organization, revokes retained legacy unscoped credentials and expires their pending consent state. Plan per-connection reauthorization; never assign old encrypted grants to a guessed organization. Verify new scoped vendor mappings before queueing new work. Previously queued snapshots retain their original destination; uncertain legacy records require operator reconciliation. Existing migrations 001–005 must retain their checksums. Multiple Books destinations still share local users, financial reports and invoice uniqueness; they are not separate tenants.

## Prepare authorized staging

1. Select a staging host, operated PostgreSQL and persistent private volume, using separate credentials and fictional data. Existing schemas need reviewed mapping/baseline plans, not blind replacement.
2. Run the app/workers as restricted OS identities behind an HTTPS reverse proxy. Keep the app bound to loopback. Set upload/body, timeout, concurrency and authentication/IP limits. Do not statically serve private storage or arbitrary `.next` files.
3. Inject `DATABASE_URL`, `APP_ENV=production`, `APP_URL=https://<approved-host>` and an absolute private `UPLOAD_DIR` through the secret manager. Use database TLS where appropriate. The public origin must exactly match `APP_URL`. Disable demo seeding and omit all `SEED_*` variables.
4. Separate runtime, migration-owner and backup identities. Runtime must not change schema or UPDATE/DELETE audit rows. Test permissions before promotion. Provision malware scanning/quarantine, retention, monitoring, encrypted backups and restore verification before production uploads.
5. Configure OCR/Books/CRM using `.env.example` and `INTEGRATION_MAPPING.md`; keep providers disabled until approved. Bound and supervise workers. Scanner configuration is deferred by user request and is not a prerequisite for manual/upload workflows.

Production authentication requires HTTPS and Secure cookies; production responses enable HSTS without preload or unrelated-subdomain policy. Verify proxy origin preservation and private/no-store responses. Read `SECURITY_REVIEW.md` for remaining MFA, CSP, malware and operational limitations.

## Authorized release

Obtain approval for the concrete release/configuration and a coordinated pre-migration backup. In a new release directory, with secrets injected securely:

```text
npm ci
npm run db:generate
npm run build
npm run check:release
npm run db:migrate
npm run start
```

Use the migration identity only for `db:migrate`, then the restricted runtime identity. Apply committed migrations; never edit applied migrations, run `migrate reset` or destructive `db push` against an existing authorized database. Never run the demo seed in production/staging. `start` binds to `127.0.0.1:3000`; configure the approved reverse proxy and process supervisor. No host-specific deployment command is claimed tested while the hosting environment remains unselected.

Bootstrap users through the guarded `scripts/create-user.ts` and securely injected `NEW_USER_*` values. Create an independent Accounts reviewer and at least two approved administrators. Recovery/deactivation use the reauthenticated operator CLI in `SECURITY_REVIEW.md`; clear bootstrap/operator secrets after use.

Smoke-test roles, login/logout/password change/session revocation, ownership, independent approvals, duplicates, payments/cancellations, job summaries, private documents, OCR review and accurate integration states. Use fictional/sandbox data; live accounting writes require separate explicit approval.

## Coordinated backups

Database and private files form one logical dataset. `pg_dump` produces a consistent database snapshot but does not include filesystem attachments or cluster-level roles. Managed snapshots/PITR may be more suitable for production; agree recovery-point/recovery-time targets and retention. [PostgreSQL pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)

For an explicitly authorized maintenance backup:

1. Pause financial writes, uploads and workers; wait for in-flight work. Record release/migration identity, UTC time, bill/document counts, financial control totals per currency and a private document hash manifest in a protected operator artifact.
2. Prepare an access-controlled backup destination. Supply PostgreSQL connection details using a protected service/passfile or injected environment. Never put credential-bearing URLs in command arguments/history/logs.
3. With authorized `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` and password/passfile configuration supplied externally, use installed compatible PostgreSQL client tools:

```powershell
pg_dump --format=custom --no-owner --no-acl --file 'E:\ProtectedBackups\approved-release\database.dump'
```

4. Snapshot/copy the whole private volume while writers remain paused, including unposted OCR documents. Preserve ACLs, hashes, encryption metadata and the matching manifest. A database dump alone is insufficient.
5. Verify checksums, encrypt backups, restrict access and copy to an approved separate failure domain. Record the coordinated boundary before resuming writers. Alert on backup failures and test restores regularly.

The `E:` path is an operator example: create and verify the actual target first. The embedded development PostgreSQL package does not contain `pg_dump`/`pg_restore`; install approved client tools or use managed backup tooling. Backups can contain password hashes, financial records, provider state and documents; treat them as secrets.

## Isolated restore drill

Use only a trusted verified archive: restoring executes database definitions from that archive. Never restore into the running application database. Disable outbound integrations/workers. Use a new empty disposable **loopback** database and separate private restore directory. [PostgreSQL pg_restore documentation](https://www.postgresql.org/docs/current/app-pgrestore.html)

With local connection details supplied securely:

```powershell
createdb --template=template0 bills_restore_approved_drill
pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname=bills_restore_approved_drill 'E:\ProtectedBackups\approved-release\database.dump'
```

Restore the matching private snapshot into a separate restricted directory. Reapply the approved ownership/privilege plan in this isolated environment; never blindly restore production grants.

Supply `ALLOW_RESTORE_VERIFICATION=true`, `RESTORE_DATABASE_URL` for the loopback `bills_restore_*` database, absolute `RESTORE_UPLOAD_DIR`, and `RESTORE_EXPECTED_BILLS`/`RESTORE_EXPECTED_DOCUMENTS` from the coordinated source manifest. Run:

```text
npm run backup:verify
```

The verifier is read-only: it checks expected bill/document counts, line/payment sums, job/vendor currencies and attached-document size/signature/SHA-256. It refuses remote/application database names and never creates, drops, overwrites or restores a database. It cannot prove completeness without the source manifest or certify external state. Separately compare financial totals per currency, migrations, users/roles, audit history, OCR queues/templates/integration work and unposted document hashes. Record duration and discrepancies. Passing verifier unit tests is not evidence of a completed backup/restore drill.

Restore verification and disposable integration-test URLs reject connection query overrides and fragments; only an optional `schema=public` hint is accepted. Do not add `host`, `port`, `user`, `password`, `options` or other query parameters to bypass the destination guards.

Before re-enabling workers, review restored outbox work and reconcile uncertain external outcomes; a restored snapshot must not create duplicate remote bills. Cleanup is a separate reviewed operator action after checking exact database names and file paths; no destructive cleanup command is supplied here.

## Rollback and monitoring

Stop the failed app/workers and restore a compatible previous build. Do not reverse migrations by deleting records or editing history. Database/storage restoration needs explicit review because it can remove post-backup changes. Restore both datasets to one boundary and reconcile external operations before resuming.

Monitor app/database health, storage capacity, authentication failures, worker retries/leases, rate limits, unknown external outcomes, backup freshness and audit-write failures. Redact request bodies, OAuth responses, passwords and database URLs. A crash between file creation and metadata commit can leave a private orphan; quarantine/reconcile through a reviewed maintenance process. Never delete financial documents merely because OCR/sync failed.

Launch still needs selected hosting/supervision, operated PostgreSQL and permissions/TLS, private volume/ACLs, malware scanning, approved accounting/provider configuration and sandbox tests, monitoring, a demonstrated coordinated restore and explicit deployment approval. Scanner configuration remains deferred by the user.

Encryption-key rotation needs a separately protected recovery store and an approved, tested re-encryption or reauthorization procedure. Replacing `INTEGRATION_TOKEN_ENCRYPTION_KEY` does not migrate existing ciphertext. Keep accounting writes/workers disabled during rotation and reconcile uncertain outbox work afterward. Cross-process token refresh and provider rotation behavior remain acceptance cases; same-process mock tests do not prove them operationally safe.
