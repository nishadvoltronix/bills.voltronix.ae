# Node deployment behind Cloudflare

**Current release scope: manual entry, outgoing Books synchronization, and automatic incoming Books/CRM updates.** Follow [the deployment runbook](../docs/MANUAL_DEPLOYMENT.md) and [incoming worker guide](../docs/INCOMING_SYNC.md). The environment keeps `MANUAL_ENTRY_ONLY=false` and retains **Save and sync**. Books authorization, company/accounting verification and the outgoing `sync` worker remain required for posting. The `incoming` worker uses separately verified Books and CRM read sources; it never enables financial writes. OCR/scanner intake remains optional. `web check` and `web check:sync` run the Books readiness inventory. `web check:manual` is only for an explicitly separate local-ledger deployment.

This package runs the application on an existing **Linux Docker host** behind the owner's Cloudflare domain. It does not change Cloudflare DNS, create hosting, import the development database, authorize Zoho or post a bill. Docker is not installed in the current Windows workspace, so the Linux image and Compose deployment have **not** been executed here.

The application needs an external operated MySQL service with verified TLS, a restricted runtime account, a separate schema migration identity and durable invoice storage. Keep `bills.voltronix.ae` on the current site until the new backend has passed login, database, upload and queue acceptance. A production Node backend can also run natively on an existing Windows server; see the final section.

## Prepare private runtime configuration

1. Copy `production.env.example` to `deploy/.env.production` **on the production host**, and supply operational MySQL and the exact Books credentials/profiles privately. Configure the CRM organization, data center, OAuth read grant, mapping and company source bindings for incoming job updates. Keep `MANUAL_ENTRY_ONLY=false`, enable the Books/CRM read gates, and retain both Books write flags false until company/accounting verification and controlled write enablement. Supply the incoming worker's protected active Admin credentials and preserve known source quota delays. OCR/scanner intake remains disabled. Do not copy the development `.env`, seed users or demo records.
2. Protect the secret file and any private CA directory with owner/group filesystem permissions. Compose bind mounts secrets as files, so the files must be readable by container UID/GID `1000`; Docker Compose `uid`, `gid` and `mode` declarations do not change the ownership of a file-backed host secret. For example, use an operator-owned directory with group `1000`, directory mode `0750` and file mode `0640`. Do not make the directory generally readable. Use an existing secret manager instead where available.
3. The runtime defaults to trusted-CA MySQL TLS. If the provider requires a private CA, place the PEM bundle at `deploy/.private/mysql-ca.pem`, set `DATABASE_TLS_CA_FILE=/run/secrets/mysql_ca`, and add `-f deploy/compose.mysql-ca.yaml` to every Compose invocation. Preserve the database DNS hostname; it must match its TLS certificate. Never disable certificate verification.
4. Provision each real company with `company:prepare`, authorize its exact Books organization and verify accounting/supplier mappings through the operational setup commands. Keep organization grants and mappings separate. Use verified imported CRM jobs or actual local jobs. The bootstrap grants its Admin operator membership; additional staff require an audited assignment to the operating company. The incoming worker needs membership in every active company sharing a CRM source. `company:prepare-manual` creates a different local-ledger company and is not the Books setup command.

The incoming template uses `INCOMING_SYNC_INTERVAL_SECONDS=5`: five seconds between completed source checks, with provider backoff and source leases preserved. Daily reconciliation remains enabled. Restart/recreate the incoming service after changing the protected setting; the visible dashboard's five-second status refresh reads only saved app data and does not call Zoho.

Only the final non-root runtime receives production secrets. The Docker build uses unused placeholders, and the Dockerfile-specific allowlist excludes all environment files, local data, private keys and uploads. `tsx` is a production dependency because the supervised workers execute TypeScript scripts. Next starts with `--experimental-next-config-strip-types`, which this installed version supports, so Node 24 loads `next.config.ts` natively after development dependencies are pruned. Do not disable Node's native type stripping in the service environment.

## Build and inspect

Run from the repository root on the Linux host using Docker Compose v2:

```sh
docker compose -f deploy/compose.yaml config --quiet
docker compose -f deploy/compose.yaml build web
docker compose -f deploy/compose.yaml run --rm --no-deps web check
```

The readiness command reads runtime, OAuth metadata, accounting mappings, company/destination verification and local catalog inventory without calling a provider or writing records. Exit `2` means setup is blocked. `LIVE_WRITES_DISABLED` is expected during setup; `CONFIGURATION_PRESENT_UNVERIFIED` still requires invoice-specific checks, actual provider confirmation, storage and host acceptance. If the schema is not installed, complete the controlled migration below first.

For a release, pin the Node and nginx base images to reviewed digests and assign `BILLS_IMAGE` an immutable release tag. The checked-in version tags are runnable starting points, not a supply-chain lock. Preserve the resulting image digest and backup/rollback instructions with the release.

## Explicit schema migration

The migration image retains the Prisma CLI; the runtime image omits build/test tooling. Migrations never run in web or worker startup.

1. Have the database operator create the empty operational schema and dedicated identities with the required grants. Do not use the local `mysql-local` helper or fictional seed. Back up any existing schema before an approved upgrade. An existing unmanaged schema requires a reviewed baseline; do not reset it to force migration success.
2. Copy `migration.env.example` to protected `deploy/.env.migration`. Select the same production schema with its separate migration identity, verified TLS and `ALLOW_PRODUCTION_MIGRATION=true` only for the intended invocation. Do not reuse the runtime account.
3. Run the migration image explicitly:

```sh
docker compose -f deploy/compose.yaml --profile tools build migrate
docker compose -f deploy/compose.yaml --profile tools run --rm --no-deps migrate
```

The wrapper adds Prisma's `sslaccept=strict` and optional CA path only to the migration child process. It does not print or modify the stored URL. MySQL DDL is not transactionally reversible; review the additive migrations before execution and retain the migration output privately. Remove the enabled migration secret from the host when the maintenance operation is complete.

## Start and route traffic

After the staged setup below and the initial verified project-association import are complete, start the full release:

```sh
docker compose -f deploy/compose.yaml up -d web proxy sync incoming job-history
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs --tail=50 web
docker compose -f deploy/compose.yaml logs --tail=50 incoming
```

The proxy listens only on `127.0.0.1:8080` (`BILLS_HTTP_PORT` can override the port). Configure the existing host's Cloudflare Tunnel to route `bills.voltronix.ae` to `http://127.0.0.1:8080` and preserve the hostname. Verify the backend before moving the domain. The web container and MySQL have no published ports in this package. The proxy drops requests for other hostnames, bounds request sizes and rate-limits login without logging callback query strings. Configure Cloudflare's edge rate limits and access policy according to the organization's actual users.

During controlled setup, explicitly start only `web proxy`. Start `incoming` after its Books/CRM source authorization and protected worker account are ready; it can run while financial writes remain disabled. Start `job-history` after the project-association migration, required source permissions and initial complete verified association import described below. Start outgoing `sync` after the runbook's accounting verification and final write-enable configuration. Web liveness probes test `/login`; they do not verify database writes, storage or provider acceptance. Run `web check`, authenticated Save and sync acceptance, and incoming source-status acceptance separately. `restart: unless-stopped` restarts exited processes; Docker does not restart a process solely because HTTP health is unhealthy. Monitor incoming heartbeat, last successful check, stale sources and quota backoff alongside job-history refresh status, outgoing queue age and failed/uncertain outcomes. Stop gracefully before backup or maintenance:

```sh
docker compose -f deploy/compose.yaml stop incoming job-history sync ocr web proxy
```

Invoice originals live in the named `invoices` volume. Preserve it and back it up together with the database, including incoming checkpoints and project-association evidence; never use `docker compose down --volumes` for an upgrade. `sync`, `incoming` and `job-history` are normal services for this release. All three share the private upload volume, runtime environment and optional MySQL CA mount. If handing over an older attachment downloader, mount its retained progress JSON privately and keep incoming attachment continuation disabled until the handoff is complete. See [original-file coordination](../docs/INCOMING_SYNC.md#original-files-and-quota-coordination). Only OCR has an opt-in profile; start it later only after its own configuration and acceptance:

```sh
docker compose -f deploy/compose.yaml --profile ocr up -d ocr
```

## Operator setup and acceptance

Trusted operator commands are explicit one-shot invocations, not startup tasks. Supply each operation's inputs through the protected runtime environment and remove temporary operator passwords afterward. The continuous incoming worker instead retains its dedicated protected `INCOMING_SYNC_OPERATOR_EMAIL` / `INCOMING_SYNC_OPERATOR_PASSWORD` for restart; production seed credentials are forbidden. The supported one-shot entrypoint commands are:

```sh
docker compose -f deploy/compose.yaml run --rm --no-deps web operator user:create
docker compose -f deploy/compose.yaml run --rm --no-deps web operator company:prepare-manual
docker compose -f deploy/compose.yaml run --rm --no-deps web operator user:manage
docker compose -f deploy/compose.yaml run --rm --no-deps web operator company:prepare
docker compose -f deploy/compose.yaml run --rm --no-deps web operator books:authorize
docker compose -f deploy/compose.yaml run --rm --no-deps web operator books:catalog
docker compose -f deploy/compose.yaml run --rm --no-deps web operator books:suppliers
docker compose -f deploy/compose.yaml run --rm --no-deps web operator books:verify-live
```

Follow each command's contract; these lines do not supply or invent company assignments, supplier IDs or operator evidence. Follow the [Save and sync acceptance sequence](../docs/MANUAL_DEPLOYMENT.md). Account recovery is included as `user:manage`; the packaged `backup:verify` operator remains restricted to a separately restored loopback database and private storage. Books setup and confirmed provider bill/attachment delivery are required for this release.

## Existing Windows server

The Linux package is optional when the owner already operates a Windows Node server. Keep the release separate from this development checkout, use Node 24 and a dedicated Windows service identity, run `npm ci`, `npm run build`, `npm run check:release`, and `npm prune --omit=dev`, then supervise these four processes using the server's existing service manager:

```powershell
node --env-file=.env node_modules/next/dist/bin/next start --experimental-next-config-strip-types --hostname 127.0.0.1
node --conditions=react-server --env-file=.env --import=tsx scripts/integration-worker.ts --watch --limit=5
node --conditions=react-server --env-file=.env --import=tsx scripts/incoming-sync-worker.ts --watch
node --conditions=react-server --env-file=.env --import=tsx scripts/job-history-worker.ts --watch
```

These commands load the protected production `.env`; a service manager can instead supply the same settings privately in its environment. Configure restart after failure and reboot. Do not use a foreground developer terminal as production supervision.

For this release, supervise web, outgoing sync, incoming sync and job history, and run `npm run check:sync` with their protected production environment. They share the protected runtime configuration, persistent private `UPLOAD_DIR` and verified-TLS operational MySQL. Route the existing Cloudflare Tunnel to the loopback application/reverse proxy. Confirm incoming source freshness/quota behavior, outgoing bill/attachment delivery, reboot/service restart, database TLS, Windows ACL and backup recovery on that host. The verified local hidden incoming process does not establish hosted acceptance or Windows reboot supervision. This package does not install a Windows service or start a visible helper window.

## Automatic verified project history

The `job-history` Compose service runs `scripts/job-history-worker.ts --watch`. A bounded local check is `npm run worker:job-history`; use `npm run worker:job-history -- --watch` under a supervisor. It uses the same protected administrator operator credentials as incoming sync and exits without reading providers when `INCOMING_SYNC_ENABLED=false`.

Apply the project-association migration and import the initial complete, verified association evidence before starting this worker. It refreshes existing cache records only: at most two due projects per pass, checked every five seconds, with a five-minute successful refresh interval and a 24-hour proof lifetime. Requests are serial GETs, paced at least 1.1 seconds apart. Source quotas, authorization errors and configured cooldowns can delay refresh. Projects-specific throttling pauses only association refreshes for that portal and CRM source; it does not pause ordinary CRM imports. Books/CRM endpoint quotas remain shared with their incoming workers. A durable lease fences duplicate workers and interrupted attempts; incomplete responses preserve the last complete proof until it expires.

The supported initial chain is US production Books project ID → explicit Zoho Projects project ID → exact CRM Deal IDs. Books consent requires `ZohoBooks.projects.READ`; CRM consent requires `ZohoProjects.portals.READ` and `ZohoProjects.clients.READ` in addition to existing CRM reads. Other data centers require an explicit supported implementation. New imported bills with those exact Books project IDs appear through the current bill-line join. This service does not discover or guess new project relationships, create jobs, assign companies to legacy CRM records, allocate financial amounts, or write provider financial records.

References: [Next self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [Docker build-context isolation](https://docs.docker.com/build/concepts/context/#dockerignore-files), [Prisma MySQL TLS](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/mysql).
