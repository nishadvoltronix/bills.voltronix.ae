# Ubuntu deployment for bills.voltronix.ae

This release supports manual bill entry with **Save and sync**, incoming Zoho Books/CRM updates and verified project history. The owner will deploy it manually using **Ubuntu, Docker and the existing Cloudflare Tunnel**. Docker is unavailable on the Windows preparation machine: the Linux image, container startup, migration and server import have not been executed there.

## Manual server handoff

Initialize a clean production MySQL database and import the existing Zoho business data using [DATA_TRANSFER.md](../docs/DATA_TRANSFER.md). It preserves the Books mirrors and originals, CRM snapshots and reconstructed jobs, while creating operational companies with fresh administrator access. Local users, fixture accounting rows and outgoing financial queues are not cloned.

The prepared configuration contains dedicated runtime/migration credentials for `mysql:3306/billing_operational`, verified TLS, the hosted origin, Books/CRM client credentials, both Books profiles and the CRM mapping. Scoped bootstrap grants for **two Books organizations and one CRM source** were checked against the source/target connection fingerprints and administrator membership. The fresh production encryption key is preserved; the old encrypted credential vault is not copied.

The permanent runtime enables incoming sync and the existing manual bill creation path with `ZOHO_BOOKS_WRITE_ENABLED=true` and `ZOHO_BOOKS_LIVE_ENABLED=true`; `ALLOW_PRODUCTION_ACCOUNTING_WRITES` stays `false`. Each company's posting remains blocked until its exact destination and current accounting mapping pass verification. A separate manifest-pinned setup environment disables all provider networking and financial writes, while a separate accounting environment allows Books reads with financial writes disabled. Both use the fresh protected Admin credential. Bootstrap grants let the runtime establish its own encrypted credentials when it refreshes authorization; hosted grant validity and accounting verification are still required.

Transfer the source release separately from these private assets:

| Local path under `G:\bills.voltronix.ae` | Ubuntu destination relative to the source root            |
| ---------------------------------------- | --------------------------------------------------------- |
| `deploy\.env.production`                 | `deploy/.env.production`                                  |
| `deploy\.env.migration`                  | `deploy/.env.migration`                                   |
| `deploy\.env.setup`                      | `deploy/.env.setup`, one-shot setup only                  |
| `deploy\.env.accounting`                 | `deploy/.env.accounting`, one-shot Books reads only      |
| `deploy\.private\mysql\`                 | `deploy/.private/mysql/`                                  |
| `deploy\.private\mysql-ca.pem`           | `deploy/.private/mysql-ca.pem`                            |
| `deploy\.private\setup-operator.json`    | Protected Admin login handoff; never an app mount         |
| `deploy\.private\data-transfer\`         | `deploy/.private/data-transfer/`, read-only during import |

The original capture and receipt remain under `.local/production-transfer/`. Source archives under `.local/deployment-release/` contain no private configuration, OAuth tokens, passwords or invoice originals. Transfer private assets through a private channel and apply the permissions in the runbooks.

Complete the server steps in this order:

1. Follow [owned MySQL setup](../docs/MYSQL_HOSTING.md): initialize the persistent database, build the images, explicitly migrate, then apply and verify restricted runtime grants.
2. Follow [data transfer](../docs/DATA_TRANSFER.md): create the fresh Admin once, prepare operational company/CRM bindings, validate the exact bundle and import it using the offline setup environment.
3. Start only `web proxy` with normal runtime configuration. Verify restored records, originals, the loopback origin and hosted login.
4. Start incoming reads and project-history verification. Allow initial reconciliation and retained quota delays to complete; imported cache data and stale proofs do not establish current hosted freshness.
5. Stop the read workers temporarily, verify every Books destination with the separate accounting environment, then start outgoing sync. Select the real supplier and each line's actual Books account and tax when entering a new bill.

Contracting metadata verification remains subject to its provider cooldown. Hosted destination verification and actual outgoing acceptance are still pending. All current invoices already exist in Zoho; use the next genuine new invoice for posting acceptance, without creating duplicate test invoices.

## Normal runtime commands

Run from the extracted source root on Ubuntu. This owned-MySQL setup needs all three normal Compose files:

```bash
dc() {
  sudo docker compose \
    -f deploy/compose.yaml \
    -f deploy/compose.mysql-ca.yaml \
    -f deploy/compose.mysql.yaml "$@"
}

# After migration, grants and successful data import:
dc up -d web proxy
dc run --rm --no-deps web check:sync
dc ps
```

The transfer runbook adds `compose.transfer.yaml` only for one-shot offline setup; accounting commands use `compose.accounting.yaml` instead. **Never use either fourth override with `up` or continuous workers.** `check:sync` inventories configuration and database evidence; imported destinations remain unverified until the accounting step completes. Fresh transfer creates no local suppliers, so `REAL_VENDOR_REQUIRED` or `VENDOR_MAPPING_REQUIRED` can remain until an actual Books supplier is selected and resolved for that company, or explicitly mapped with `books:suppliers`. No dummy invoice is needed. Web health probes cover `/login`, so database, storage and provider acceptance require separate checks.

When the protected Admin, scoped grants and source bindings are ready:

```bash
dc up -d incoming job-history
dc logs --tail=50 incoming job-history
```

Incoming checks run 60 seconds after completed passes, with daily reconciliation, durable leases and provider backoff. The dashboard's five-second refresh reads saved app data. Imported project associations start `STALE`; `job-history` rechecks the exact Books project → Zoho Projects project → CRM Deal evidence before treating it as current. It does not guess relationships.

Monitor source freshness, quota delays, attachment completion, project-proof freshness and eventual outgoing failures. Verify service recreation and host reboot. `restart: unless-stopped` handles exited processes; an unhealthy HTTP probe alone does not restart a container. Retire duplicate local polling during manual cutover once hosted polling is established.

Preserve both `mysql_data` and `invoices` volumes during upgrades. Back them up with the production encryption key and verify a restore. Do not use `docker compose down -v` for an upgrade. Quiesce writers before maintenance:

```bash
dc stop incoming job-history sync ocr web proxy
```

OCR/scanner intake remains disabled. OCR has an optional Compose profile and requires separate setup and acceptance.

## Cloudflare Tunnel and hosted login

Probe the origin before routing the hostname:

```bash
curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --header 'Host: bills.voltronix.ae' http://127.0.0.1:8080/login
```

Expect HTTP `200`. Configure the existing tunnel with public hostname `bills.voltronix.ae`, origin `http://127.0.0.1:8080`, and HTTP Host Header `bills.voltronix.ae`. The app origin remains `https://bills.voltronix.ae`. If `BILLS_HTTP_PORT` changes, update the tunnel and probe consistently.

This loopback route assumes `cloudflared` runs on the host or uses host networking. A bridge-network container has a separate loopback interface. Preserve existing tunnel credentials and unrelated routes. For a locally managed tunnel, merge [the ingress example](cloudflared.ingress.example.yaml) before the final catch-all and validate with `cloudflared tunnel ingress validate` and `cloudflared tunnel ingress rule https://bills.voltronix.ae/login`. For a dashboard-managed tunnel, update the hostname's origin and Host Header. [Cloudflare ingress](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/), [origin settings](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)

Register these callbacks in the existing Zoho clients for hosted reauthorization when needed:

```text
https://bills.voltronix.ae/api/integrations/oauth/zoho/callback
https://bills.voltronix.ae/api/integrations/oauth/crm/callback
```

Prepared scoped grants avoid requiring new consent solely because the database is fresh. Revoked grants or changed client/source identities still require correction from the hosted Admin session. Confirm the hosted encrypted credential records before retiring optional bootstrap token values. Preserve the production encryption key with every production backup.

## Accounting review and outgoing activation

The prepared profiles use the organizations' AED base currency and require explicit line selection. Every bill line must select a valid expense account and tax from that company's Books catalog; expense and tax defaults are not inferred. Select the real Books supplier during manual entry. These per-bill checks remain required after activation.

Use the separate accounting environment for provider reads and destination verification. It is generated from the current runtime profiles and encryption key, with Books networking enabled, CRM and incoming networking disabled, and all financial-write flags disabled. If the runtime credentials or mappings change, regenerate both derived environments with `sudo node deploy/prepare-transfer.mjs --manifest-sha256=<reviewed bundle digest>` before verification, then reapply the UID 1000 file permissions from the transfer guide. This preserves the runtime's enabled posting flags and existing Admin password.

```bash
daccount() {
  sudo docker compose \
    -f deploy/compose.yaml \
    -f deploy/compose.mysql-ca.yaml \
    -f deploy/compose.mysql.yaml \
    -f deploy/compose.accounting.yaml "$@"
}

# Avoid competing provider reads and keep outgoing processing stopped.
dc stop incoming job-history sync
daccount run --rm --no-deps \
  -e ALLOW_BOOKS_POSTING_ACTIVATION=true \
  -e BOOKS_ACTIVATION_REFERENCE=manual-bill-activation-20261030 \
  web operator books:activate
```

This command uses the protected Admin and verifies exact operational destinations with provider reads; it does not create a Zoho bill. Expect `VERIFIED` for every configured operational destination. `WAITING_QUOTA`, `WAITING_SOURCE` or `BLOCKED` returns a nonzero result: retain the reported retry time and existing cooldowns, correct any reported prerequisite and keep `sync` stopped. Incoming and history workers may resume between verification attempts; stop them again before retrying. Optional catalog reads use this same `daccount` environment with their specific operator inputs and allow flags.

Operator commands are explicit one-shot invocations using protected, reviewed inputs. Supported operations include `user:create`, `user:manage`, `company:prepare`, `crm:prepare`, `books:authorize`, `books:catalog`, `books:suppliers`, `books:verify-live`, `books:activate`, `data:transfer` and the separately guarded `backup:verify`. The permanent runtime does not retain `NEW_USER_*` provisioning fields.

`data:transfer prepare` creates this handoff's operational companies, memberships and CRM bindings. For later staff assignment, create the real staff account and use `COMPANY_SETUP_MEMBER_EMAIL` with the exact `company:prepare` inputs. `company:prepare-manual` creates a separate local-ledger company and is not the Books setup command.

After every destination is verified, use the already enabled permanent runtime to recreate services and start outgoing synchronization. Keep `ALLOW_PRODUCTION_ACCOUNTING_WRITES=false` and `MANUAL_ENTRY_ONLY=false`:

```bash
dc up -d --force-recreate web incoming job-history sync
dc run --rm --no-deps web check:sync
```

With host Node available, `sudo node deploy/prepare.mjs --check-posting` checks the files offline without printing secrets. It does not establish provider acceptance. The next genuinely new bill must appear locally and receive a confirmed Zoho Books ID plus original-attachment completion. Saved or queued status is not confirmed delivery. No new test invoice was posted during this preparation.

## Other installations and build isolation

For a new installation without the prepared data handoff, `node deploy/prepare.mjs` creates private templates without overwriting existing files. `node deploy/prepare-mysql.mjs --configure-env` prepares owned MySQL; an external operator can instead supply an equivalent verified-TLS database and separate identities. The generic [manual deployment guide](../docs/MANUAL_DEPLOYMENT.md) covers that fresh setup. Do not repeat its initial provisioning over an imported target.

Migrations require separate credentials and explicit approval for each invocation; web and workers never migrate on startup. The wrapper supplies Prisma's strict TLS settings without changing the stored URL. The runtime excludes build/test tools, uses Node 24's supported native loading of `next.config.ts`, and retains `tsx` for workers. Build inputs are allowlisted; private configuration, data, keys and originals are excluded. Pin reviewed image digests and preserve the release manifest and rollback procedure.

Further references: [MySQL hosting](../docs/MYSQL_HOSTING.md), [incoming synchronization](../docs/INCOMING_SYNC.md), [production readiness](../docs/PRODUCTION_READINESS.md), [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [Docker build-context isolation](https://docs.docker.com/build/concepts/context/#dockerignore-files).
