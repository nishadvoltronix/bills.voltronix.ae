# MySQL transition changed-file manifest

Snapshot: 2026-10-28T08:03:32.828Z. Baseline: 2026-10-28T07:12:49.160Z from the private source checkpoint at `.local/mysql-transition-baseline-20261028/manifest.json`. All paths below are relative to `G:\bills.voltronix.ae`.

Compared **177 checkpointed public files** and **28 additional files** in the documented source scope: **57 changed, 28 new to the checkpoint, 120 unchanged, 0 missing**.

Classification uses SHA-256 content hashes, not Git status: this repository has no initial commit. New means absent from the captured source baseline. The scope includes every checkpointed public path, current files under `src`, `scripts`, `tests`, `prisma` and `docs`, and current root Markdown documents. The pre-existing, uncheckpointed root `AGENTS.md` is excluded rather than incorrectly classified as new. Other uncheckpointed root configuration/generated files are outside this comparison. This manifest itself is an additional new report and is excluded from its own hash/count table.

Excluded: `.env` contents and hashes, `.local` evidence/credentials/data, PostgreSQL/MySQL binary data, private uploads, dependencies, generated clients, build outputs, screenshots and test-run artifacts. The `.env.example` template is included. Hashes identify this snapshot; later edits require regeneration.

## PostgreSQL and private-data preservation

All **8 original PostgreSQL source files** - the original Prisma schema, six SQL migrations and migration lock - match both their recorded baseline SHA-256 and preserved checkpoint copy. The protected original PostgreSQL environment backup matches the baseline environment hash: **yes**. The active local environment differs from the baseline: **yes**. Only these comparison results are disclosed; no credential values or environment hashes are published.

| Retained path | Current files | Current bytes | Latest file modification (UTC) | Modified after checkpoint |
| --- | ---: | ---: | --- | ---: |
| `.local/postgres` | 1406 | 68847072 | 2026-10-27T12:38:54.649Z | 0 |
| `.local/uploads` | 34 | 1734 | 2026-10-27T12:09:21.821Z | 0 |

These directories remain in place. Current file timestamps are consistent with preservation. The baseline did **not** capture their contents, so this report does not claim a bytewise before/after comparison, a database restore drill or complete data-migration acceptance. The new MySQL instance and uploads use separate `.local/mysql-dev` and `.local/mysql-uploads` locations. No original PostgreSQL rows were copied into MySQL.

## Changed and new files

| State | Category | Path | Baseline SHA-256 | Current SHA-256 |
| --- | --- | --- | --- | --- |
| Changed | Dependencies and configuration | `.env.example` | `677e87434ec8552369a349af23fa3970c8e0241d4b3c317f51990ed05df49b16` | `41641e237e421e7fe55dbcca70dec01928b76b2146694f8f48ed8c39d32fa5a1` |
| Changed | Documentation | `DEPLOYMENT.md` | `ee2777d202f6870641d24796363e9ff182ae6394ca6b9a6967a4471bfad67280` | `0b6f31ed5ac88dd38f9d7d15d53e7ca33922d060657316c422f946a455c1116f` |
| Changed | Documentation | `IMPLEMENTATION_STATUS.md` | `c54cca8d537118d41ac4bc746f36abb2b2148f9349719d5e9f68bb5714a1b19b` | `41de065c54ee5a5e9403190be23cb9df04163316be7035dddb0af4182acac542` |
| Changed | Documentation | `INTEGRATION_MAPPING.md` | `bf4e691ef95abf335e8a713aa8808d56eb804da443210c00d2bb6568a5b70885` | `a0f72dd1a340628f0e2f7dbd42cd77f8b2a72aa3334e0b36df8618f88d7492f8` |
| Changed | Documentation | `README.md` | `3e25c5d62a7b60e774ab4771a74305bd51f7a596b38036c92a1b5507d3817818` | `57fe3e584327af01d858afa9b42a2374e40ec2b36e4dde2ec7dcf40a12b6ca81` |
| Changed | Documentation | `REMAINING_WORK.md` | `1b7e5708c46bb874dcc54d592d0cedb036400bb8428505bfaf99af1a1b0861f1` | `751e5a56cbd557cdb2f69e85ab8aeeeecabf456329537e579ad944eec516ae97` |
| New | Documentation | `docs/HUB_BILLING_BRIDGE.md` | - | `ba2d8423030e79271c655859acee64ff2083f1aa102292e7fb7a4d84d0014e9f` |
| New | Documentation | `docs/MYSQL_MIGRATION_PLAN.md` | - | `fd50d069efaa1c7deac69a22ff3a20d8e1ae38f5791ca9587f32bd221552759b` |
| New | Documentation | `docs/MYSQL_VALIDATION_REPORT.md` | - | `2b03540035b2ea3d617904b534e62ac5af356ec910e68a86728c42a1b33ba9d1` |
| New | Documentation | `docs/POSTGRES_DEPLOYMENT_ARCHIVE.md` | - | `203e3f2f2bba6cadd0652e2530758f97eb2711e968166fb4f1fa2f8779907577` |
| Changed | Dependencies and configuration | `package-lock.json` | `22dc843c6534b6c660894bdc085012918da482bed3570d5dd33564ecc8816ac4` | `7f6a3919c1ef11074b9aaf9488a8b7281935f1f196a373134d02f4ab2dfa5ece` |
| Changed | Dependencies and configuration | `package.json` | `dc5d0004a708b7d6cf5182d93795a217045fa108bc5e747552203572bd2d15ef` | `65985e0ede7f5d001d8ae7020f80390efe87d0643c9b80cf47830163ae614c9a` |
| Changed | Dependencies and configuration | `prisma.config.ts` | `c0a854129f7c8c53c9b8e61552e6a2fda93fed629312f1100e9a8ce9b59a7e37` | `747e56189c9e35b1066ee577206baacaf4cbc8beaffb631b0cbbe59c951a0aa8` |
| New | MySQL schema and migrations | `prisma/mysql/README.md` | - | `20606881ef5b9fd67db56595273269ec147030e57ef62b7743672e878831a3c6` |
| New | MySQL schema and migrations | `prisma/mysql/migrations/202610280001_mysql_company_baseline/migration.sql` | - | `bd498d9e9cd1b38ff423085ab9e130df21f32bcd71b1b7631a8edb31fa7e8685` |
| New | MySQL schema and migrations | `prisma/mysql/migrations/202610280002_hub_bridge_nonce/migration.sql` | - | `6fd20af463853ddbaf38b07aee5ec42f3eb5434f0e65c903e7e46d253b9c94f7` |
| New | MySQL schema and migrations | `prisma/mysql/migrations/migration_lock.toml` | - | `00969ee045a3c3f087a3460235a1a744c1e35bde4441e0c55e163225eb077608` |
| New | MySQL schema and migrations | `prisma/mysql/schema.prisma` | - | `2bf8eabb5fcb7e6047db3616da5de411b327e2265ff5906bc29d02b13a40ae6e` |
| Changed | Local database and verification tools | `scripts/check-integration-readiness.ts` | `3bc58e8761c2bc013e4b888880fdd42fa7246bec52686c63db8ad31344a995fe` | `8d2600e8abf70339405f0b618f027e926c3d8c0eb3f0d2f4afa32fba79356425` |
| New | Local database and verification tools | `scripts/hub-mysql-fixture.mjs` | - | `72b4c7d1710b88da3c0f3d12b71bfa402b0e9c0cdf1baf332f7c621c8ce48d29` |
| Changed | Local database and verification tools | `scripts/lib/local-test-database.mjs` | `c9ed88bfaae313728e9f7fa0fdb4bec815ca9c690bbea510c9d7318743d5b792` | `5de839345062f1d3ee6f2bf2e2944f6808173a94e508c92e10f9a5fe58d87578` |
| New | Local database and verification tools | `scripts/lib/mysql-local-admin.mjs` | - | `e29dd595ee8ac10843a6f23bc7d77a8336360fde4926b6c934aa6674db84de89` |
| New | Local database and verification tools | `scripts/mysql-local.mjs` | - | `2011257913a133567c677602b684a0f6841889b669db01ce984fd01fafedefbe` |
| New | Local database and verification tools | `scripts/mysql-migrate.mjs` | - | `0092329a88a409a4ed9176b0bd1e2927f4a12f937ea67cca1b6789b9d2236369` |
| Changed | Local database and verification tools | `scripts/seed.ts` | `3ec1daa5fa9db1890626bfe4d5979aeb264b46db49822a16eb1e3cfffac2dac7` | `9c5ac4abeda599b284392bdf08900735f98ee3e08fc42fdd3ba8693a36def19c` |
| Changed | Local database and verification tools | `scripts/test-integration.mjs` | `aa576694fd99af8116e1c02f24debf516b79eb83a84322e2ff77077f77192ae1` | `4fa9aee125b0a86b9d68bb405c46b501c6d98336252050288f2fc48af2f88411` |
| New | Local database and verification tools | `scripts/verify-mysql-restart.mjs` | - | `377235cfdb7508950d6d735e8144f9e680f7a8482c54b33f92dbde05b423a9df` |
| New | API and application routes | `src/app/api/companies/route.ts` | - | `fc7637dab3c79d2f65e91867f80e7230ebfca59909873993908591dc794bc05a` |
| New | API and application routes | `src/app/api/hub/job-billing/route.ts` | - | `b379f6f46524523d9749d5acbfefaa73949015e9ad1654de74b63e6b45858d78` |
| Changed | API and application routes | `src/app/api/integrations/route.ts` | `7fbfac488a0cabe80ca8309c2355b1ee79587dc0406ad319a7779824c6ec2540` | `05b2ae6136bae7479c7627618d44f274517ec1575a369d6ff388a06df840cac0` |
| Changed | API and application routes | `src/app/api/jobs/route.ts` | `38338b9b9758959b7f7cd438c09a42d51e605789ab54ed883d07eda980092c86` | `22752cf684ec30f1ee4a56ef4cab9d38d68d6055af2ab6ece11b5b8d822d59c1` |
| Changed | API and application routes | `src/app/api/ocr/route.ts` | `88334d9a9fcabf50f7c9acc3cf97d6e947b57777a737b8c57ba1c1a8d93db05e` | `9823db08ff80836f3c03bf98317c92074973bfff866f67ee9e4013c8c1d1b9cd` |
| Changed | API and application routes | `src/app/api/vendors/route.ts` | `e731e193669c44615408de2be45403fec780983295cbfce498d793d0a093de3c` | `aab14a605ce5df58e56be9f4118501d454d873213a0024b1ddbe842a98f2bffd` |
| Changed | Application forms and displays | `src/components/bill-detail.tsx` | `5bb18abb1a32d4344975a9f8e8c0f0c3f100faefa5acbd72c5aa313275b923a5` | `e41d588648fba6f5d4b8d06f4eb4c5e9d10c4451fa7ca9f807803c13a8dc81b3` |
| Changed | Application forms and displays | `src/components/bill-form.tsx` | `cf03a3f129d009fe558ff5cd2ac375bb6ec3fa7a368ce6c3d1750f028de49685` | `4f9392d13b254bcddf188088b875d2b200ee21656204f57a3d5f4dabbc523c8d` |
| Changed | Application forms and displays | `src/components/bills-list.tsx` | `527fa53c5c679c3362648d5acd39229013577339a77435fa455a792ce0e3e7b1` | `1c6e73ab5cc143e94ca6d4bc4defe3d4ad78c45673b24d53dc833d0aea3eb1d2` |
| New | Application forms and displays | `src/components/company-select.tsx` | - | `1590ec88f81b0a857cf786e9f2e0d1ccb7bdf081226cc57f3681d6cc36bf04ec` |
| Changed | Application forms and displays | `src/components/dashboard.tsx` | `a9564f3d73e49cab24fd1d4d87b1934aec43e9f2718499d3925de0a4c8c24e72` | `9966c7c4afeb72799cd0a8b4697828af2ec6da4fd6fd8093f515123409934498` |
| Changed | Application forms and displays | `src/components/expense-report.tsx` | `a580e6ac0ee294620e12bfeb8bc18e800b7eac4899871be61a6ac3eb805c4fa7` | `f0ce4cc5b967593776cfc43ddec305b1d8686cd9c731294a820e56406c314c68` |
| Changed | Application forms and displays | `src/components/jobs.tsx` | `ff7d04c513fe4a9d9d1a2608fec2a72a7bebbb682c80d5be5f31972a91011408` | `70c78c247bd91695b04d3a5b0bcbf2d03f4557167edd38872b60d6213ce5178a` |
| Changed | Application forms and displays | `src/components/ocr-workspace.tsx` | `af58e86b2e61221465e6a74b19b3a8f37be1d14a60fbb4e4d47b78ae66f0abf2` | `7d885eda8d253bdfec3dc09e440fcf145c86fc3c39a79c038477afd06a43f3d0` |
| Changed | Application forms and displays | `src/components/types.ts` | `c6e33d7ca743f251b71f46372fbb85781eef74883ad830c9af2debdb41cb100f` | `acc70641e69f90f63bc54d25e89f68365a5c7cf208391fcc079488d6fe3a3ced` |
| Changed | Application forms and displays | `src/components/vendors.tsx` | `86b1904d8557f0212444e4b90da0ff1cc88b784d39a604e5fe525846249c0151` | `add559179a8af06489317c7bf5140857abb90b1636bd8a1c65436b8f757c29dd` |
| Changed | Authorization, financial services and integrations | `src/lib/auth.ts` | `4e8285c6ce100de0c54404d8553f0d34c697277c5d98670f1071dce35736513f` | `c46cc751e0afdb49b0097b493db6eef1c417ee873734c640cfbe719633dbf650` |
| New | Authorization, financial services and integrations | `src/lib/company.ts` | - | `c18dbb900febdb6f0d79c17509b91c3c87a35f260f9bd5413c4ba535b8a98dde` |
| Changed | Authorization, financial services and integrations | `src/lib/db.ts` | `005d83c79951523c4fe51bc2ed20e5a1504509ab5af976ee3747ad8cada675c8` | `c68e9bf8f718c1162c0d1b143a5dcfc6cc6141e037a48dac9122247778452f6c` |
| New | Authorization, financial services and integrations | `src/lib/hub-bridge/service.ts` | - | `758ab19d71e5d82dc30508afdb714f9aba3e33e834455d3973c68e32ead29aff` |
| New | Authorization, financial services and integrations | `src/lib/hub-bridge/verify.ts` | - | `cff1cc19046053a4d5084e6420ae7cf0398c82baeb5e975a9db733b17e46aea8` |
| Changed | Authorization, financial services and integrations | `src/lib/integrations/books.ts` | `0432381d47952b8e21bb311c7dea0afb9c231800268de9cabe2bc20d72f1f8da` | `d4c339ac7960cba42690ec2dd4e010689904ea152aa0f94b78513d6b9fcd38f8` |
| New | Authorization, financial services and integrations | `src/lib/integrations/company-destination.ts` | - | `d3f7f57dda1bf559dfd9e36d90521e55ba39a4431efcedfa8f46cc4dca3aa068` |
| Changed | Authorization, financial services and integrations | `src/lib/integrations/crm.ts` | `8963ce1556e26b293968fcbf8057d6a13f36fdec8734278abb2e80dba6245ceb` | `9dca23d89757c9dd61f50ff957ddf3e99158c4e408aa8ed605ed53ec3f6f4e97` |
| Changed | Authorization, financial services and integrations | `src/lib/integrations/oauth.ts` | `0b7b8f7c3d5411182ccd59d97dc59a5dea5d3c2cc8f97f9e9651df886fc73636` | `6ad4af98f3af598d3711fd5bffd0fbed53b0a9dcb98cfc9306e3f1d86aad7ab9` |
| Changed | Authorization, financial services and integrations | `src/lib/integrations/queue.ts` | `5da6f3609270d33fd4a10b48819acdbc3c098cbac6c4c24912227ecc741a7b6d` | `582690fc5b38be79210caaa7ab578cc1d107bd6a2e62e973de922ae77a96bb1b` |
| Changed | Authorization, financial services and integrations | `src/lib/integrations/vendor-mapping.ts` | `9b288174891b66f8c50512c3a4b30e2b407f021623885ea062e9878d9c57c490` | `c9f5e463860871de1f1acccee26db69b31e0d96dd4fa2d122324178e006123d0` |
| New | Authorization, financial services and integrations | `src/lib/mysql-connection.ts` | - | `6fed10b9c9ae798bb1b67bf718026bdc155a236198a7de8b984b396e84c0ec6d` |
| Changed | Authorization, financial services and integrations | `src/lib/permissions.ts` | `229860a85e1404f3b52e6407d7294a83db36353ec0f55a63238800dc88c5292a` | `b7b812796500dfeb0636200a5f14adab3adbaf960952487acbe3334e1fba1d2b` |
| Changed | Authorization, financial services and integrations | `src/lib/reports.ts` | `1f8c61bc057e46883c655ed177ebbaa655e264620de36f251ebdbdb521e67bde` | `cc2ad509afd04cab3f778ae9de9560d2d48574af1e072ac3e274838d9a3a1c40` |
| Changed | Authorization, financial services and integrations | `src/lib/security/authentication-attempts.ts` | `46a580f83ede275a0a7d0708630c72e50685e7dd6f770334b729ab1038878854` | `b046971c2c3ff800e3baa8c718fc560e73180d4a46aabefbba9232e4293c707d` |
| Changed | Authorization, financial services and integrations | `src/lib/security/restore-verification.ts` | `38d95c1c667fbdfac50deddebb365e8923107642b030444904c74ecde6cc9399` | `325f070f0c342d27061aef6a5eddb013be7767821ce2ffad95d9d0a6bd67ed0c` |
| Changed | Authorization, financial services and integrations | `src/lib/services/bills.ts` | `bf1032e2eb97b82174a11d020afcedfa39e95626333ef4e03d1bfe2cb622d240` | `a11e2b3c633cbfe153d8c9b7b24e90c00c87b4ee4359117c21fefbca2045ea10` |
| Changed | Authorization, financial services and integrations | `src/lib/services/catalog.ts` | `c5a6ddbc0c47b891e5f75ecf0d2dd0b62be3595ad874d53740f4c8ce7412e95e` | `2dbf85be1956cedff0ef973c24d3157fb37a89a4b6244dec976cf7349f2ca53d` |
| Changed | Authorization, financial services and integrations | `src/lib/services/documents.ts` | `3ff29dd61773c5f55512f9fbaed4cb086a915d04be271cf7db1aed29f484ae13` | `7f0bb6145955f17bdcd96d7774218a81b718e76a77c9dba4ddfee31e7d6fc063` |
| Changed | Authorization, financial services and integrations | `src/lib/services/integrations.ts` | `176746cdcc96dcc13aeba2d171f4090b55f75d24bc67e2fd7eafc94bfcdd81ca` | `124ac0f18f083d2363949884b093b5d166e9897c4d884439d2f636aa9d7a454f` |
| Changed | Authorization, financial services and integrations | `src/lib/services/ocr.ts` | `e543b3d2ed060b4985595f2f5b1b78deaf2001b5638c50e33ed307634b1d23e1` | `42b9946627ac317805f8d21115450673824885e5325f4e0f9dd1a4de548cd9e7` |
| Changed | Authorization, financial services and integrations | `src/lib/services/reports.ts` | `498b91cddee2b8be2f638258dac47aad0d1d5ee2569824db2f63f1af768eafd8` | `ea9cf96221232b311cf377fbeed5a34ff7e0afaedb9a3ac2c23a8d68d95426ba` |
| Changed | Authorization, financial services and integrations | `src/lib/validation.ts` | `6c9a57791dfd78a2e45214e1eea510396afc02b90b4b45a9d0cb1b6d834b7df0` | `4eb4b6402ea681d0640c5902ca82eef98bb49446d411373bc9a20484a93d8186` |
| Changed | Automated validation | `tests/accounts.integration.test.ts` | `ba1850d9b5b0b7e85bac49da666cca20ef2ed1bd2f6221e3cfa0fb1822bd6e82` | `412a70cb3512a00b388968604666e20a1e09c32ddc83ac800a05217eb1f896a2` |
| New | Automated validation | `tests/company-fixtures.ts` | - | `bc96ff1f2d2318e4c7879e0c14af03f8d2ddcc2b7263c6150060f9d7df242fb5` |
| New | Automated validation | `tests/company-isolation.integration.test.ts` | - | `c6dc4706d052a56795a09e2d8c2cebecd77bac7487215ed077fe63f4a1fd87bf` |
| Changed | Automated validation | `tests/e2e/books-organizations.spec.ts` | `bff18e0fecf4a8a2bf2943c471457da757f13712c9394aa33c89188c4537c777` | `9d7d4f2a8244d93ade6d469ae139ed433509b7725538327dfca505ad8f9f9890` |
| Changed | Automated validation | `tests/e2e/mvp.spec.ts` | `7b86fc8c0a5928fdbc63ef331bbe674ee6a8aae53cdbee6b975e9a1bc2ea4ef9` | `5c5d029ff6b5fa3d48735feef128598b5c47848c26a0644a30d0051fff54c187` |
| Changed | Automated validation | `tests/e2e/ocr.spec.ts` | `29d2d343aadaec9bf4ae7663ddfdf76248f0e0da2f9f4feea7f7000a5f95fb63` | `7b76db10ee041bc19bf023d1de656aba547dc0030f59f200c23c4d7aae3a0e35` |
| New | Automated validation | `tests/hub-bridge.integration.test.ts` | - | `c37bb3800498b08d4d3ef01c74781c92895511707d6cdab27e2cbee40acc0323` |
| New | Automated validation | `tests/hub-bridge.test.ts` | - | `fb3b71f69e8b3602512c40cfd8907cdb94f03481670eb6af3a8598006cd6769c` |
| Changed | Automated validation | `tests/integrations.integration.test.ts` | `3b972b67ce6d95756489b0adea35f0757b6d393577b9b458b483f9dfc66b6f94` | `5b31c83ca419eebfb7b3a0493c0621e66cbf949399127b0a089390a736edae96` |
| Changed | Automated validation | `tests/multi-organization-oauth.test.ts` | `6bc3484a018a13503250c7304c8a9486560c4a81a25282e7f724d18f20a0b3ec` | `0aa360bf48a3c39ca571162ac09ecedd2d41377a96e5ed75e3d676a26df8ba4f` |
| New | Automated validation | `tests/mysql-connection.test.ts` | - | `8f512b79a14cec3339906d98b31209a3bbd8ed7abb52f87540c7d7efcc0b3d71` |
| New | Automated validation | `tests/mysql.infrastructure.integration.test.ts` | - | `426d1d787f356ff1843e4172248dcf7d7a28012e8b9a7fef210a09e39181d588` |
| Changed | Automated validation | `tests/ocr.integration.test.ts` | `890f8b54d284d60e69e4894b102340c922bc92f079e2d970249d106ab11d382c` | `470df03403d1263af06f33b97fc54c3d9b852e8ebae9f17f30f72872bde37a67` |
| Changed | Automated validation | `tests/restore-readiness.test.ts` | `e1527031268144e5ad4aa10afc3dc64d40fa1ef17bcbeeff76290210ccb5f8d8` | `2d4cff2b006b58b68bfc259a14204e2eca6e6082202be09feb7db32d28abe893` |
| Changed | Automated validation | `tests/restore-verification.integration.test.ts` | `c6b2dc45c303b055a0adf21b9dcfa016338f531b259022f066f754515bd95763` | `ba1ab6f1aaccd74d22a7ba2e00860f4f8e9125721e5036465d7d3f604cb1f591` |
| Changed | Automated validation | `tests/restore-verification.test.ts` | `cb7dc893b4809ebee36e273e8688a5aa8f0b4df8f14847229b5b84433a18072f` | `89bce70247c774baa301c9dae4e4b844b017523cf5a121b22f9a850a43c7aa4f` |
| Changed | Automated validation | `tests/security-readiness.test.ts` | `5c046c263ac4004ebdede2e8f323639f5f7f7029734bfe41ce98d55aea61d40b` | `27308280eed2106a13ec919a4854ebbf3e6077c8cce8aeb3608f5aadd8adcbb9` |
| Changed | Automated validation | `tests/test-database-guard.test.ts` | `86f6f8199983799594965233823cf414ff20f996c23766256bdadaa080b5b582` | `e124d65bb59f0a0443477c63b1e709f62e5b4a727b326ffd7e7919184ca0b737` |
| Changed | Automated validation | `tests/workflows.integration.test.ts` | `6ac0c9744fa8a270534a03664888a777777155749ee95deb40d28a8ed324f387` | `d421cca484ac39b882bd4d032da30dedc4351d778db45cf076b8e071baca1fb5` |

## Review boundary

The inspected company access, financial workflow, attachment and OCR changes revealed no unresolved P1 issue in this review. The final schema verification receipt records 25 tables, 232 columns, 27 enforced CHECKs, 31 foreign keys and 48 unique indexes including primary keys. The migration command's verify-only path now performs privilege inspection instead of re-granting privileges. These are bounded implementation/evidence checks, not a production security certification or live provider acceptance. Production data and hosting were not changed.

The final executed test outcomes, acceptance limitations and remaining deployment requirements are recorded in [MYSQL_VALIDATION_REPORT.md](MYSQL_VALIDATION_REPORT.md). The private machine-readable comparison receipt is `.local/mysql-dev/preservation-review.json`.
