-- An operator's exact temporary local test is distinct from normal live permissions.
ALTER TABLE `LiveSyncAuthorization`
  ADD COLUMN `purpose` VARCHAR(32) NOT NULL DEFAULT 'LIVE',
  ADD COLUMN `localProof` JSON NULL,
  ADD COLUMN `localProofHash` CHAR(64) NULL,
  ADD CONSTRAINT `LiveSyncAuthorization_purpose_check`
    CHECK (`purpose` IN ('LIVE', 'LOCAL_ONE_BILL_TEST')),
  ADD CONSTRAINT `LiveSyncAuthorization_local_proof_check`
    CHECK ((`purpose` = 'LIVE' AND `localProof` IS NULL AND `localProofHash` IS NULL)
      OR (`purpose` = 'LOCAL_ONE_BILL_TEST' AND `localProof` IS NOT NULL
        AND JSON_TYPE(`localProof`) = 'OBJECT' AND `localProofHash` IS NOT NULL
        AND REGEXP_LIKE(`localProofHash`, '^[a-f0-9]{64}$', 'c')));
