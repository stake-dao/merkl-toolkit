# merkl-toolkit

Stake DAO's reward pipeline for vault holders: it reads incentives from the Merkl distributor, allocates them by time-weighted balance and writes the cumulative merkle the distributor pays from. Real user funds depend on every root. The pipeline and its steps live in `docs/architecture.md`.

## Ways to hurt yourself

- **Running the pipeline locally against `data/`.** `pnpm tsx src/main.ts` and `make -f automation/distribution.mk` rewrite the tracked `data/` files. The distribution workflow runs the same command and commits `data/` to `main` by itself, so a PR never regenerates or hand-edits `data/`.
- **Reading `sentOnchain: true` as an on-chain fact.** `generateMerkle()` sets it once the merkle file is written. No transaction happens in this repo.
- **Treating the patch artefacts as inputs.** `data/last_merkle.json.bak` and `data/patched_merkle.json` come from the one-off fix and patch scripts.
- **Trusting `docs/architecture.md` over the code.** It predates the curve recovery, the trusted-sender filter and the vault fallbacks. The code wins.

## Code Review Rules

### Merkle

- P0: in a distribution run the merkle is cumulative: every `(user, token)` amount is at least its amount in the previous merkle, and a debt redirect only reduces the new reward. A repair script that rewrites pairs, like `fix_wrapper_distributions.ts`, states why and proves its sums (source: src/utils/merkle.ts)
- P0: a change to `generateMerkleTree` keeps the leaf encoding and `sortPairs` the distributor verifies, since an incompatible change invalidates proofs (source: src/utils/merkle.ts)
- P1: amounts are summed per checksummed `(user, token)` before `generateMerkleTree`, which keeps only the last value of a duplicate key, so a change upstream of it never feeds two entries for the same pair (source: src/utils/merkle.ts)

### Amounts

- P0: arithmetic on token amounts, weights and time-weighted products stays in `bigint`, and files carry them as decimal strings through `safeStringify` and `safeParse`, never a `Number`, a float or a division by a power of ten. A `Number` that only yields a sort comparator's sign is the one exception (source: src/2_distribution.ts)
- P0: per window, user allocations sum exactly to the window amount, the remainder going to the last entry and a window with no weight to the incentive manager, and the depositors of an expanded wrapper sum exactly to the wrapper's amount (source: src/2_distribution.ts)
- P1: a debt redirect moves the same amount from the user to the treasury for the same token, the remaining debt is persisted, and the solvency check subtracts that remaining debt from pending (source: src/4_check.ts)

### Pipeline gates

- P0: `check()` runs after `generateMerkle()` and before the breakdown and the cache refresh, and its solvency check keeps exiting non-zero on a deficit, since the workflow commits only when `main.ts` exits zero (source: src/main.ts)
- P1: `refreshCache()` stays the last call of `main()` (source: CLAUDE.md)
- P1: a vault with no code, or whose holder balances fall short of its total supply, stops the run with a non-zero exit, and the one deliberate skip is a vault deployed after the window end. A change keeps those exits and adds none of its own silent skips (source: src/2_distribution.ts)

### Incentives

- P0: a cross-chain incentive is imported only from a trusted VoteMarket hook sender, since the distributor records bridged incentives without proof the tokens arrived. A change to `isTrustedIncentive` or its sender set updates its test (source: src/tests/untrusted_sender.ts)
- P0: an incentive's `distributedUntil` only moves forward, to the end of a window distributed for it, so no period is paid twice or skipped. Today the tail loop of `distribute()` clears the cursor of every incentive that got no window in the run, so its next window restarts from its start. A change there or to the skip paths fixes that or proves the cleared incentive was never distributed (source: src/2_distribution.ts)
- P1: a change to the curve recovery config keeps the exact match on the incentive id and on its gauge, reward, amount, manager, sender and chain (source: docs/curve-historical-recovery.md)

### Outputs

- P1: a change to the shape or serialization of a file under `data/` that consumers read (the merkle, the distribution, the incentives, the breakdown) states which reader it breaks and ships the matching reader change (source: docs/architecture.md)
