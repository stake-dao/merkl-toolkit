# Curve historical recovery (ENG-2225)

The hook stored leftovers under their registration week and discarded the original
campaign epoch. The six originals below were recovered from successful Arbitrum
transaction calldata, matched to exact token deposits into the hook.

Recovery covers each **full original campaign week**, `[Thursday 00:00 UTC, next
Thursday 00:00 UTC)`. This compensates historical holders; it does not reconstruct
the receipt time of a bridge that never happened. The toolkit's Thursday 01:00
adjustment was introduced on 12 May 2026 and does not apply here.

| Hook epoch / index | Campaign | Token | Historical week, UTC | Original deposit |
| --- | --- | --- | --- | --- |
| `1769040000 / 0` | 971 | SPELL | 22–29 Jan 2026 | [Transaction](https://arbiscan.io/tx/0x65020c6196cd28aaabb217e179139cf94568be31628da11fe6d14c7a91958be1) |
| `1771459200 / 3` | 988 | YND | 5–12 Feb 2026 | [Transaction](https://arbiscan.io/tx/0xfbb2dd6f8e3252dd5b63f163dd8121df87e85423a939202d781f51743d30f4b6) |
| `1772064000 / 3` | 988 | YND | 12–19 Feb 2026 | [Transaction](https://arbiscan.io/tx/0x5ab7e053c9892a62f78937bc48714d94b1a68ba7c762acb9a08b19dda939beaa) |
| `1772064000 / 4` | 988 | YND | 19–26 Feb 2026 | [Transaction](https://arbiscan.io/tx/0x6e82c4647d999815a9aa754a72af8593202d174924c3742c2c4b317b65ebe700) |
| `1773273600 / 0` | 1081 | SDT | 12–19 Mar 2026 | [Transaction](https://arbiscan.io/tx/0xda4e1582b703c4b2841f5b2e26c10a5ad3b5b5f180f45d5e9bb288ee2f90581b) |
| `1773273600 / 1` | 1165 | tBTC | 12–19 Mar 2026 | [Transaction](https://arbiscan.io/tx/0xe1c570e1abf1f654bd572220d6bbbdf91083b16e38270eba7efa402d1a6ba08d) |

Historical vaults in the config are supported by toolkit incentive records saved
before each campaign: [SPELL, incentive 11](https://github.com/stake-dao/merkl-toolkit/blob/bc6f508270cfe5d362a21aee5f6b3be67e8beec0/data/incentives.json),
[YND, incentive 23](https://github.com/stake-dao/merkl-toolkit/blob/389011c9ab247b9639e2600f168a5ed4024e2ad0/data/incentives.json),
and [SDT/tBTC, incentives 206/212](https://github.com/stake-dao/merkl-toolkit/blob/8595033d9328f9862c5f261c9b505c555eb7daec/data/incentives.json).
Archival checks confirmed that all four vaults existed with positive total supply
before these weeks.

## Use after an authorized bridge

1. Keep this importer change active before recovery. After bridging and delivery,
   identify each new mainnet `IncentiveAdded` ID from the corresponding delivery
   events; check the hook sender, source chain, gauge, token, amount and manager.
2. Fill the six `incentiveId: null` fields in
   [`config/curve-recovery.json`](../config/curve-recovery.json) with those exact IDs.
   No IDs are invented before delivery. Matching unconfigured leftovers from ID
   `2467` onward are skipped with a warning; other incentives continue normally.
   Once configured, missing recovery IDs are retried even if the import cursor has
   advanced. Already imported incentives are not fetched again. Invalid recovery
   fields or historical weeks also skip only the affected incentive.
3. Run the regular pipeline only when authorized. New incentives receive the
   historical `start`, `end`, `duration`, vault and initial `distributedUntil`.
   Existing imported records are not modified or reset on subsequent runs.

The existing historical balance/transfer calculation distributes over each original
week and adds claims to the cumulative Merkle amounts. Its existing per-second
integer rounding is unchanged (less than 604800 raw token units left per week).
Existing cursors and later holder caches are preserved. Do not reset incentive data, roots or previous distributions.

No transaction, bridge or production distribution was executed while implementing
this change.
