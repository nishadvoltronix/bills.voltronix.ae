#!/usr/bin/env bash
set -euo pipefail
# The initial temporary server has skip_networking=1. Do not report ready
# until the official entrypoint has completed initialization and restarted it.
ready=$(mysql --defaults-extra-file=/run/bills-mysql/root-client.cnf \
  --protocol=socket --batch --skip-column-names \
  -e "SELECT @@skip_networking=0 AND @@require_secure_transport=1 AND @@lower_case_table_names=1 AND @@global.time_zone='+00:00' AND EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='billing_operational')" 2>/dev/null)
test "$ready" = 1
