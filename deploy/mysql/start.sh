#!/usr/bin/env bash
set -euo pipefail
umask 077

# Compose file secrets retain host ownership. Copy them as root into private
# tmpfs, then use the account from the image instead of assuming a numeric UID.
# https://github.com/docker-library/mysql/blob/master/docker-entrypoint.sh
test "$(id -u)" = 0
test "${1:-}" = mysqld
test "$(id -u mysql)" != 0
mkdir -p /run/bills-mysql /docker-entrypoint-initdb.d
cp /run/secrets/bills_mysql_root_password /run/bills-mysql/root-password
cp /run/secrets/bills_mysql_ca /run/bills-mysql/ca-cert.pem
cp /run/secrets/bills_mysql_server_certificate /run/bills-mysql/server-cert.pem
cp /run/secrets/bills_mysql_server_key /run/bills-mysql/server-key.pem
cp /run/secrets/bills_mysql_bootstrap /docker-entrypoint-initdb.d/20-bills.sql
root_password=$(cat /run/bills-mysql/root-password)
[[ "$root_password" =~ ^[a-f0-9]{64}$ ]] || exit 1
printf '[client]\nuser=root\npassword=%s\nsocket=/var/run/mysqld/mysqld.sock\n' "$root_password" > /run/bills-mysql/root-client.cnf
unset root_password
chown mysql:mysql /run/bills-mysql /docker-entrypoint-initdb.d
chown mysql:mysql /run/bills-mysql/* /docker-entrypoint-initdb.d/20-bills.sql
chmod 0700 /run/bills-mysql /docker-entrypoint-initdb.d
chmod 0600 /run/bills-mysql/* /docker-entrypoint-initdb.d/20-bills.sql
exec /usr/local/bin/docker-entrypoint.sh "$@"
