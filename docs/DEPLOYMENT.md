# Deployment guide

For the current typed-entry **Save and sync** release, follow [MANUAL_DEPLOYMENT.md](MANUAL_DEPLOYMENT.md). Zoho Books authorization, operational mapping and the sync worker are required. OCR, scanner intake and CRM lookup remain optional. The production template keeps `MANUAL_ENTRY_ONLY=false`; `npm run check:sync` inventories the intended configuration. See [current provider and host verification](BOOKS_PRODUCTION_VERIFICATION.md) for remaining blockers.

The current manual release, secure configuration, account administration, backup/restore verification, worker supervision, and rollback instructions are maintained in [DEPLOYMENT.md](../DEPLOYMENT.md).

The current **Save and sync** workflow has no separate bill approval or preview confirmation. The guarded production Books branch remains disabled locally; OAuth connection-check workspaces remain accounting-disabled. No provider financial write or hosted deployment has occurred. Follow [LIVE_SYNC_SETUP.md](LIVE_SYNC_SETUP.md) and [current validation/status](APPROVAL_FREE_SYNC_VALIDATION.md). [LIVE_SYNC_VALIDATION_REPORT.md](LIVE_SYNC_VALIDATION_REPORT.md) is the historical preceding milestone.

Read [SECURITY_REVIEW.md](../SECURITY_REVIEW.md) for production blockers and account-recovery controls, and [INTEGRATION_MAPPING.md](../INTEGRATION_MAPPING.md) for provider configuration and verified mappings. Scanner intake is implemented locally; real share/Azure activation remains unverified as documented in [scanner setup](SCANNER_IMPORT_SETUP.md). No deployment or production data change has been performed.
