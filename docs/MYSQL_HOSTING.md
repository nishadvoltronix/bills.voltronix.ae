# Owned MySQL on Ubuntu

Use this optional package when the Ubuntu server will own its MySQL database. The base deployment continues to support an external TLS-enabled MySQL service. This package initializes a **fresh** MySQL 8.4 data volume and keeps it across container replacement. No database port is published on the host.

## Prepare privately on the local machine

Run from the repository root with Node 22.12+ and OpenSSL. Git for Windows' bundled OpenSSL is detected automatically; `OPENSSL_BIN` can name a different executable. Arguments are passed directly to the executable without a shell.

```powershell
node deploy/prepare-mysql.mjs --configure-env
node deploy/prepare-mysql.mjs --check
```

Preparation makes no database connections or provider requests. It creates the following ignored files:

| Path                           | Purpose                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `deploy/.private/mysql/`       | Three distinct database passwords, private CA/server keys, certificates, initialization SQL and a preparation receipt |
| `deploy/.private/mysql-ca.pem` | Public CA certificate mounted into app containers                                                                     |
| `deploy/.env.production`       | Only its placeholder database URL and database TLS settings are filled                                                |
| `deploy/.env.migration`        | Only its placeholder database URL and database TLS settings are filled                                                |

Existing credentials and certificates are preserved and checked. An existing external database URL, unrelated CA, incomplete private bundle, expired certificate or redirected path is refused. The helper does not rotate keys or change OAuth credentials, the token-encryption key, incoming cadence or financial-write flags. It preserves all unrelated environment bytes and existing environment-file permissions. A server certificate must remain valid for at least 30 days; arrange explicit renewal before the expiry recorded by `--check`.

Keep this private material separate from the source release archive. Transfer it securely to the matching paths on Ubuntu. The CA private key is retained for renewal but is never mounted into any container. The root password and initialization SQL are mounted only into MySQL. The current typed-data handoff uses separately prepared scoped grants and preserves the fresh production encryption key; it does not restore the old encrypted vault. A later full production-database restore must retain that production database's own encryption key.

## Initialize the Ubuntu database

The commands below assume the reviewed source is extracted at `/opt/voltronix-bills` and the private files have been transferred. Docker Engine and the Compose plugin must already be installed. Keep app and worker services stopped until migration, data transfer and verification finish.

```bash
cd /opt/voltronix-bills

# App processes run as UID 1000; database secrets remain root-only on the host.
sudo bash <<'PERMISSIONS'
set -euo pipefail
chown 1000:1000 deploy/.env.production deploy/.env.migration
chmod 0600 deploy/.env.production deploy/.env.migration
chown root:root deploy/.private deploy/.private/mysql deploy/.private/mysql/*
chmod 0700 deploy/.private deploy/.private/mysql
chmod 0600 deploy/.private/mysql/*
chmod 0444 deploy/.private/mysql-ca.pem
PERMISSIONS

dc() {
  sudo docker compose \
    -f deploy/compose.yaml \
    -f deploy/compose.mysql-ca.yaml \
    -f deploy/compose.mysql.yaml "$@"
}

dc config --quiet
dc pull mysql
dc up -d --wait mysql
dc --profile tools build web migrate
dc --profile tools run --rm --no-deps -e ALLOW_PRODUCTION_MIGRATION=true migrate
dc exec -T mysql /bin/bash /opt/bills-mysql/grant-runtime.sh
```

The migration approval applies to that one invocation; `deploy/.env.migration` remains disabled by default. The root-only grant command grants DML on the 35 application tables, permits only `SELECT` and `INSERT` on `AuditLog`, and gives the runtime no access to `_prisma_migrations`, schema DDL or grant delegation. The migrator has separate privileges limited to the operational schema. Reapply and verify runtime grants after a reviewed schema migration adds tables; the grant list is checked against the Prisma schema by a regression test.

For an existing-data deployment, import the prepared typed data bundle and exact originals next, using [the data transfer runbook](DATA_TRANSFER.md). Its setup commands add `deploy/compose.transfer.yaml` as a fourth override and use the separate private setup environment. The transfer prepares operational companies and reconstructs mapped jobs from source evidence. Verify source counts, file hashes and grants before starting web or workers. Database transport and imported records do not authorize production accounting; production mappings and posting require separate verification. Existing Zoho invoices must not be entered again for this verification.

After the transfer and read-only checks pass, return to [the production deployment handoff](../deploy/README.md) for application startup, Cloudflare Tunnel, OAuth callbacks and accounting verification. Include **all three** Compose files in subsequent `run`, `up`, `logs` and `exec` commands; omitting the owned-MySQL override can leave the application pointed at an unavailable database.

## Transport, persistence and operations

The database hostname is `mysql`, schema is `billing_operational`, and both app and migration URLs use port 3306 with distinct generated users. TLS is mandatory on the server. App settings remain `DATABASE_TLS_MODE=verify-full` and `DATABASE_TLS_CA_FILE=/run/secrets/mysql_ca`; the server certificate explicitly covers `DNS:mysql`. MySQL's automatic certificates do not provide the hostname identity required for this verification. [MySQL TLS documentation](https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html)

The wrapper initially runs as root, copies file secrets into private tmpfs, assigns them to the image's named `mysql` account and sets mode 0600. It then delegates to the official entrypoint, which drops privileges. This avoids assuming that a MySQL image uses UID 999, and avoids granting the app access to database root credentials. `MYSQL_USER` is intentionally unused because the official image otherwise grants all database privileges to that user. [Official image documentation](https://hub.docker.com/_/mysql), [official entrypoint](https://github.com/docker-library/mysql/blob/master/docker-entrypoint.sh)

`lower_case_table_names=1` is configured before initial data-directory creation, consistently with the existing local MySQL. Do not apply this package to an existing volume initialized with a different value. MySQL prohibits changing that setting after initialization. [MySQL server variables](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html#sysvar_lower_case_table_names)

The `mysql_data` volume contains database state; the separate `invoices` volume contains originals. Preserve both during upgrades. Never use `docker compose down -v` for a normal upgrade. Back up the database, originals and original encryption key together and verify a restore. A source archive does not contain these private assets. Use a tested MySQL 8.4 image; `BILLS_MYSQL_IMAGE` can pin the reviewed image digest for repeatable upgrades.

Local validation covers private preparation, OpenSSL certificate verification, Compose structure, grants and shell syntax. Docker was unavailable on the preparation machine, so an actual Ubuntu container startup and database migration remain host-side checks.
