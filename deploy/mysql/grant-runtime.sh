#!/usr/bin/env bash
set -euo pipefail
client=(mysql --defaults-extra-file=/run/bills-mysql/root-client.cnf --protocol=socket --batch --skip-column-names)
/bin/bash /opt/bills-mysql/healthcheck.sh
# This package's Prisma schema contains 35 application tables plus migration
# metadata. The regression test keeps the grants in sync with the schema.
ready=$("${client[@]}" -e "SELECT COUNT(*)=36 AND SUM(LOWER(TABLE_NAME) IN ('auditlog','_prisma_migrations'))=2 FROM information_schema.TABLES WHERE TABLE_SCHEMA='billing_operational' AND TABLE_TYPE='BASE TABLE'")
test "$ready" = 1 || { echo 'Run the reviewed Prisma migrations before granting runtime access.' >&2; exit 1; }
ready=$("${client[@]}" -e "SELECT COUNT(*)>0 AND SUM(finished_at IS NULL AND rolled_back_at IS NULL)=0 FROM billing_operational._prisma_migrations")
test "$ready" = 1 || { echo 'Migration history is incomplete.' >&2; exit 1; }
"${client[@]}" < /opt/bills-mysql/grant-runtime.sql
ready=$("${client[@]}" -e "SELECT
  (SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('billing_runtime'),'@',QUOTE('%')) AND PRIVILEGE_TYPE<>'USAGE')=0
  AND (SELECT COUNT(*) FROM mysql.role_edges WHERE TO_USER='billing_runtime' AND TO_HOST='%')=0
  AND (SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('billing_runtime'),'@',QUOTE('%')))=0
  AND (SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('billing_runtime'),'@',QUOTE('%')))=138
  AND (SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('billing_runtime'),'@',QUOTE('%')) AND (TABLE_SCHEMA<>'billing_operational' OR LOWER(TABLE_NAME)='_prisma_migrations' OR IS_GRANTABLE='YES' OR PRIVILEGE_TYPE NOT IN ('SELECT','INSERT','UPDATE','DELETE') OR (LOWER(TABLE_NAME)='auditlog' AND PRIVILEGE_TYPE NOT IN ('SELECT','INSERT'))))=0")
test "$ready" = 1 || { echo 'Runtime privilege verification failed.' >&2; exit 1; }
printf 'Restricted runtime privileges verified; AuditLog permits SELECT and INSERT only.\n'
