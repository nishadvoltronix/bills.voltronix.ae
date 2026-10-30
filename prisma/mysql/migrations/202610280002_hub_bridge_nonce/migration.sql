-- Short-lived authentication replay state; no financial data is changed.
CREATE TABLE `HubBridgeNonce` (
  `nonceHash` CHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`nonceHash`),
  INDEX `HubBridgeNonce_expiresAt_idx` (`expiresAt`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
