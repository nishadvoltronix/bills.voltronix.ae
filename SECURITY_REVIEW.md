# Security review

Current policy update, 28 October 2026: **Save and sync** replaces independent bill approval. Authorized writers may finalize their own bills; company membership, ownership, exact versions, original attachments and runtime/provider guards remain enforced. READY and historical APPROVED bills are financially recognized; payment is still a separate Accounts/Admin action. The production branch remains disabled locally. See [current validation](docs/APPROVAL_FREE_SYNC_VALIDATION.md) and [setup](docs/LIVE_SYNC_SETUP.md).

The review below was performed against the earlier master specification on 2026-10-27 (Asia/Dubai). Its independent-approval and unsupported-production statements describe that historical milestone, not current workflow. This is an implementation review and automated-test record, not an independent penetration test or production certification. No production data, credentials, services, or DNS were changed during that review.

## Implemented controls

| Area                          | Behavior                                                                                                                                                          | Verification                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Authentication                | Salted scrypt hashes; opaque random session tokens stored as SHA-256 hashes; eight-hour expiry; HttpOnly/SameSite cookies; Secure over HTTPS                      | Authentication/workflow tests             |
| Session lifecycle             | Active account/current role checked on protected requests; logout revokes its session; password changes/resets/deactivation revoke all sessions                   | Account/workflow integration tests        |
| Recovery                      | Trusted-host operator reauthenticates an active Admin, supplies an audit reason, and resets credentials; no public reset endpoint or public default administrator | Account integration tests and guarded CLI |
| Authorization                 | Server-side roles and Data Entry ownership; contract/profit values hidden from Data Entry; read-only Management; independent financial approval                   | Workflow integration/browser tests        |
| Authentication limits         | Atomic identity-based counters for login, password change and operator authentication; five attempts per 15-minute window                                         | Authentication/account tests              |
| Input and financial integrity | Same-origin mutations, bounded bodies, Zod, exact decimal calculations, database constraints, optimistic versions and transactions                                | Financial/workflow tests                  |
| Documents                     | Generated private keys; 10 MB limit; PDF/PNG/JPEG signature and MIME checks; private-path/symlink checks; size/hash verification; protected download headers      | Private-storage/workflow tests            |
| Secrets/releases              | Server-only services, ignored local secrets/files, release tracing exclusions and artifact check                                                                  | Build/release checks                      |
| HTTPS/headers                 | Production authentication fails closed without HTTPS; no-sniff, frame denial, CSP, same-origin referrer, production HSTS; camera restricted to same origin        | Configuration and HTTP/browser checks     |

The actual combined test totals belong in `IMPLEMENTATION_STATUS.md`. Test names do not establish that production infrastructure or external providers were exercised.

## Account operations

`POST /api/auth/password` requires an active session, same-origin request, the current password, and a different replacement of 14–128 characters. Success updates the hash, revokes all sessions, and requires sign-in again. Wrong-password attempts are rate limited. Login rechecks credentials transactionally so a password check started before recovery/deactivation cannot issue a session afterward using stale credentials.

Use `scripts/manage-user.ts` on the trusted host for `deactivate`, `reactivate`, `reset-password`, or `revoke-sessions`. Supply these values through the operator's secret manager/process environment, never shell arguments or chat:

- `ALLOW_ACCOUNT_ADMINISTRATION=true` for this invocation.
- `ACCOUNT_OPERATOR_EMAIL` and `ACCOUNT_OPERATOR_PASSWORD` for an existing active Admin.
- `ACCOUNT_OPERATION`, `ACCOUNT_EMAIL`, and `ACCOUNT_REASON` (10–500 characters; no secrets).
- `ACCOUNT_NEW_PASSWORD` only for reset (14–128 characters).

Run `npm run user:manage` locally, or `node --conditions=react-server --import=tsx scripts/manage-user.ts` with authorized environment injection. Clear operator/provisioning variables afterward. The CLI does not accept email alone as administrator proof. Self-deactivation is refused; use an independent administrator. Accounts are deactivated, never deleted, to preserve historical financial attribution. Inactive-account recovery requires separate, audited reactivation before resetting the password.

Recovery is operator-assisted: verify identity through an approved channel, record the reason, deliver the replacement securely, and have the user change it after sign-in. Delivery and forced first-use rotation are not automated. There is no email/SMS transport or anonymous reset-token flow. Maintain at least two approved administrators. Loss of all administrator credentials requires a separately authorized incident/bootstrap procedure using trusted host/database access and the existing provisioning CLI.

## Production blockers and limitations

1. **Malware scanning/quarantine is not connected.** Signatures/hashes do not establish harmless content. Configure a supported scanner and fail-closed quarantine before untrusted production uploads, OCR processing, or forwarding documents externally. Test infections, scanner downtime, timeouts and clean-document release. Current helpers never claim a file is malware-free.
2. **Backup/restore infrastructure is unverified.** Restore database and private files together and record a successful isolated drill. The read-only verifier does not perform a backup or restore; see `DEPLOYMENT.md`.
3. **MFA/SSO is not implemented.** Select an approved identity provider/tenant before OIDC/SAML work. Plan issuer+subject identity mapping, controlled account linking, state/nonce/PKCE, redirect validation, MFA/step-up and session revocation. Never infer privileges from unverified email/domain claims.
4. **One shared workspace, multiple external Books destinations.** Management/Admin/Accounts retain workspace-wide access. Books tokens, vendor mappings and queued operations are destination scoped, but this does not provide tenant, legal-entity, branch or job-membership isolation. Only use multiple destinations where all workspace users are authorized for the shared local data. Separate company access and separate local ledgers require a new authorization/data design.
5. **OS/database privileges are essential.** Use Windows ACLs or equivalent for private storage; POSIX modes alone do not establish Windows access control. Separate runtime/migration/backup identities and prevent runtime audit UPDATE/DELETE. Privileged SQL can bypass service-level cross-record rules.
6. **Network controls remain required.** Configure trusted-proxy/IP rate limiting, bounded upload/concurrency/time limits, private database connectivity, secret rotation, monitoring and retention. Identity-based throttling does not stop distributed abuse and can temporarily lock a targeted account.
7. **CSP permits Next inline scripts/styles.** Nonce-based CSP remains a hardening task; production does not enable unsafe-eval. Test nonce changes against App Router streaming/hydration.
8. **Operational security is not fully configured.** External immutable audit archival, centralized alerting, key-management and incident-response procedures remain organizational work. Never log invoice bodies, OAuth responses, passwords or database URLs.

OCR text is untrusted evidence, including embedded instructions. It must not choose arbitrary URLs, invoke tools, grant permissions or bypass human review. Server-side adapters and successful mocked tests do not prove a live provider connection. Scanner configuration is deferred by the user's instruction; no printer capabilities or scanner connectivity are claimed.

## Release gate

Production readiness requires configured operational controls, successful authorized sandbox/provider tests, reviewed accounting mappings, a demonstrated coordinated restore and explicit release approval. This review does not authorize deployment or live accounting writes.

## Integration readiness follow-up

See [INTEGRATION_READINESS.md](INTEGRATION_READINESS.md) for evidence and actual final check results. The follow-up closed these local issues without changing applied migrations:

- Books writes require an expiring operator attestation for the exact independently verified nonproduction target, explicit test mode, unchanged mappings and an uncached organization check before each POST. Production destinations/CRM writes remain refused. The attestation relies on trusted operator evidence; organization metadata alone cannot prove isolation.
- Queue claims serialize attachments per bill/target and hold sibling uploads while an unknown outcome awaits reconciliation. Snapshot hashes survive JSONB key ordering; queued destination/mapping drift fails closed. Unknown creates never trigger automatic POST replay.
- OAuth refresh-token rotation persists encrypted successor credentials and audits the change. Bootstrap refresh authorization requires the encryption key before token exchange and stores credentials durably. Refresh coalescing is process-local; cross-process web/worker refresh behavior still needs provider acceptance. This does **not** implement encryption-key rotation: stop workers, disable writes, preserve the protected recovery key, and use a separately approved/tested re-encryption or provider reauthorization procedure. Never replace the key and assume old ciphertext remains usable.
- Disposable database/restore guards reject connection query overrides and URL fragments; only the optional `schema=public` hint is permitted. This closes the PostgreSQL driver's ability to override a loopback URL host using query parameters.
- Management attachment uploads are denied before body buffering, and JSON requests require the exact JSON media type. New tests exercise anonymous access, stale sessions/current roles, ownership, approval independence, private paths/junctions and OAuth restrictions.
- Release scanning covers short credentials, provisioning and PostgreSQL password variants plus encoded forms; failures never print credential-bearing parse exceptions.

These changes do not provide malware quarantine, an operated secret manager, a coordinated restore drill, host supervision, deployment health checks, infrastructure rate limiting or independent penetration testing. Those remain release blockers.
