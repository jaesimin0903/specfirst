Synthetic watcher files for ADR 0006, made by generate.mjs. Nothing here happened on any chain: the addresses
(0xfeed...0001 to 0007, subscriber 0x5ee0...0001), blocks, transaction hashes, attestation ids and results are made
up. The 30 property ids, descriptions and failure texts are copied from real reports in ../board/checks so the
pages render real wording. 143/feed.ndjson covers every feed kind and contains two lines a reader must skip.
checks/ holds the report files the feed's reportPath values point to (certs/checks/... maps onto this directory
when SPECFIRST_CHECKS_DIR points here).
