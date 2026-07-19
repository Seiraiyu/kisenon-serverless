# Changelog

## [0.1.1](https://github.com/Seiraiyu/kisenon-serverless/compare/v0.1.0...v0.1.1) (2026-07-19)


### Bug Fixes

* derive version and enforce live test config ([34d6f07](https://github.com/Seiraiyu/kisenon-serverless/commit/34d6f07ccc94606de3902ad1da920314e1f1a0a3))
* **ws:** close socket on fatal frame violation ([d81385e](https://github.com/Seiraiyu/kisenon-serverless/commit/d81385ecbd4ad3007c42059765637bbea31e90a5))

## 0.1.0 (2026-07-14)


### Features

* connection-string parse + discrete config normalization ([a8df8a6](https://github.com/Seiraiyu/kisenon-serverless/commit/a8df8a6e584e17f824dfea92310bd02b5715f5d7))
* HTTP transport + neon() tagged-template + transactions (Phase 3) ([27dd48e](https://github.com/Seiraiyu/kisenon-serverless/commit/27dd48eb4d7da91bd31faacbcba356cb8b9dc9d1))
* neonConfig singleton with neon-parity defaults ([3a89567](https://github.com/Seiraiyu/kisenon-serverless/commit/3a895673de02a4bdafa73cd9ad02aff2635c93e1))
* PG wire-protocol core (reassembler, builders, parsers) ([37eb74b](https://github.com/Seiraiyu/kisenon-serverless/commit/37eb74b51a560f54ebe612876ea60758ac40422e))
* Pool + Client pg-shaped HTTP one-shots + index wiring (Phase 4) ([a16880b](https://github.com/Seiraiyu/kisenon-serverless/commit/a16880b794fd17607c868f6e2fd0ac4e8e8c9f27))
* pool.connect() WS sessions + LISTEN/NOTIFY + WS-absent fallback (Phase 8) ([1a1791d](https://github.com/Seiraiyu/kisenon-serverless/commit/1a1791d0991c1fb8c30acd8bc1d485fa6f56cb85))
* pure-JS MD5 (RFC 1321) + md5 auth PasswordMessage ([1af7cba](https://github.com/Seiraiyu/kisenon-serverless/commit/1af7cbaec0633f559970fc23d9de51b35db1b5c6))
* SCRAM-SHA-256 client auth over Web Crypto ([ab25d8e](https://github.com/Seiraiyu/kisenon-serverless/commit/ab25d8e83ae762c21f56351d028b1ad67ff0b95c))
* shared PgResult/Field types + zero-dep EventEmitter ([e2458da](https://github.com/Seiraiyu/kisenon-serverless/commit/e2458da0850c5d0a03d03a043257425038531196))
* type-parser registry (text-&gt;JS by OID) ([dd7bc47](https://github.com/Seiraiyu/kisenon-serverless/commit/dd7bc472f86948d922e1e67c5a131475ad072678))
* WebSocket transport + runtime adapter (Phase 7) ([e15f18e](https://github.com/Seiraiyu/kisenon-serverless/commit/e15f18e2a4f75c89f83ce0cc1a086b52b558557e))


### Bug Fixes

* **ci:** release-please.yml block-style outputs ([658a869](https://github.com/Seiraiyu/kisenon-serverless/commit/658a86927032999a40d3bade0f4faa7984fdde4d))
* **connstring:** percent-decode database name ([78dcd27](https://github.com/Seiraiyu/kisenon-serverless/commit/78dcd27677a8afc9a3e4b75eae564db52b1e4288))
* share Postgres-text param serializer between HTTP and WS ([1cd144c](https://github.com/Seiraiyu/kisenon-serverless/commit/1cd144ce6587c432c45e187456845ba75b668c74))
* **ws:** Workers fetch-upgrade needs http(s):// URL, not ws(s):// ([32b298c](https://github.com/Seiraiyu/kisenon-serverless/commit/32b298cf853cb3d24018ebade0f0661b0ccc128a))


### Miscellaneous Chores

* release 0.1.0 ([3277706](https://github.com/Seiraiyu/kisenon-serverless/commit/3277706393181f9db251bdbeca22ce2f0244e1e1))
