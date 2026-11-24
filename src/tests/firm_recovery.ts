import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Distribution } from "../interfaces/Distribution";
import type { SerializedEarnedEntry } from "../interfaces/Breakdown";
import type { MerkleData } from "../interfaces/MerkleData";
import { reassignFirmBalance, FIRM_RECOVERY, repairFirmDistribution, repairFirmEarned } from "../recovery/firm";
import { createCombineDistribution } from "../utils/merkle";
import { safeParse } from "../utils/parse";

const r = FIRM_RECOVERY;
const otherUser = "0x2222222222222222222222222222222222222222";
const window: Distribution = {
    timestamp: r.timestamp, blockNumber: r.blockNumber,
    incentives: [{
        vault: r.vault, token: { address: r.token, symbol: "DOLA", decimals: 18 },
        distribution: { incentiveId: r.incentiveId, incentivePerSecond: 3762999452654602n, amountToDistribute: r.amount },
        users: [{ user: r.escrow, amount: r.amount.toString(), balance: "9743999999999999632233330889748257339183", share: "100.000000" }],
    }],
};
const entry = window.incentives[0];
const repaired = repairFirmDistribution(window);
assert.deepEqual(repaired.incentives[0].users, [{
    ...entry.users[0], user: r.beneficiary, source: "firm",
    firmEscrows: [{ escrow: r.escrow, amount: r.amount.toString() }],
}]);
assert.equal(window.incentives[0].users[0].user, r.escrow);
assert.deepEqual(repairFirmDistribution(repaired), repaired);
assert.throws(() => repairFirmDistribution({ ...window, timestamp: window.timestamp + 1 }), /historical distribution/);
assert.throws(() => repairFirmDistribution({ ...window, incentives: [entry, entry] }), /historical distribution/);
assert.throws(() => repairFirmDistribution({ ...window, incentives: [{ ...entry, vault: otherUser }] }), /vault, token or allocation/);
assert.throws(() => repairFirmDistribution({ ...window, incentives: [{ ...entry, users: [{ ...entry.users[0], amount: "7" }] }] }), /allocation/);
assert.throws(() => repairFirmDistribution({ ...window, incentives: [{ ...entry, users: [{ ...entry.users[0], user: otherUser }] }] }), /recipient/);
assert.throws(() => repairFirmDistribution({ ...window, incentives: [{ ...entry, users: [{ ...entry.users[0], user: r.beneficiary }] }] }), /provenance/);

const fromKey = `${r.escrow}-${r.token}`;
const toKey = `${r.beneficiary}-${r.token}`;
const earning: SerializedEarnedEntry = { timestamp: r.timestamp, vault: r.vault, amount: r.amount, source: "direct" };
const unrelatedEscrow = { ...earning, vault: otherUser, amount: 1n };
const laterBorrower = { ...earning, timestamp: r.timestamp + 1, amount: 2n };
const cached = { [fromKey]: [earning, unrelatedEscrow], [toKey]: [laterBorrower] };
assert.equal(repairFirmEarned(cached, r.timestamp - 1), cached);
const migrated = repairFirmEarned(cached, r.timestamp);
const firmEarning = { ...earning, source: "firm" } as const;
assert.deepEqual(migrated, { [fromKey]: [unrelatedEscrow], [toKey]: [firmEarning, laterBorrower] });
assert.equal(repairFirmEarned(migrated, r.timestamp + 1), migrated);
assert.equal(cached[fromKey][0], earning);
assert.equal(cached[toKey].length, 1);
assert.deepEqual(repairFirmEarned({ [fromKey.toLowerCase()]: [earning] }, r.timestamp), { [toKey]: [firmEarning] });
assert.throws(() => repairFirmEarned({}, r.timestamp), /missing or.*ambiguous/);
assert.throws(() => repairFirmEarned({ [fromKey]: [earning, earning] }, r.timestamp), /ambiguous/);
assert.throws(() => repairFirmEarned({ [fromKey]: [earning], [toKey]: [firmEarning] }, r.timestamp), /ambiguous/);
assert.throws(() => repairFirmEarned({ [toKey]: [earning] }, r.timestamp), /ambiguous/);
assert.throws(() => repairFirmEarned({ [toKey]: [{ ...firmEarning, amount: r.amount - 1n }] }, r.timestamp), /ambiguous/);

// The archived parent is immutable even after newer rounds have been generated.
const snapshots = path.resolve(__dirname, "../../data/distributions");
const originalJson = readFileSync(path.join(snapshots, "1795521683/merkle.json"), "utf8");
const original: MerkleData = JSON.parse(originalJson);
const history: Distribution = safeParse(readFileSync(path.join(snapshots, String(r.timestamp), "distribution.json"), "utf8"));
assert.equal(original.merkleRoot, r.parentRoot);
assert.equal(original.claims[r.escrow].tokens[r.token].amount, "36666666666666441888");
assert.equal(original.claims[r.beneficiary]?.tokens[r.token], undefined);

const corrected = reassignFirmBalance(original, history, 0n);
assert.equal(corrected.merkleRoot, "0x6aa852437ce487180adaa33c0a12b8c6601d6b814d5475e67b8333ab0a012fe6");
assert.equal(JSON.stringify(original), originalJson.trim());
function amounts(tree: MerkleData): Map<string, bigint> {
    const pairs = new Map<string, bigint>();
    for (const [user, claim] of Object.entries(tree.claims)) {
        for (const [token, leaf] of Object.entries(claim.tokens)) pairs.set(`${user}-${token}`, BigInt(leaf.amount));
    }
    return pairs;
}
const expected = amounts(original);
assert.equal(expected.size, 2751);
assert.equal(expected.delete(fromKey), true);
expected.set(toKey, r.amount);
assert.deepEqual(amounts(corrected), expected);
assert.equal(reassignFirmBalance(safeParse(originalJson), repairFirmDistribution(history), 0n).merkleRoot, corrected.merkleRoot);
assert.throws(() => reassignFirmBalance(corrected, history, 0n), /original published root/);
assert.throws(() => reassignFirmBalance(original, history, r.amount), /already been claimed/);
assert.throws(() => reassignFirmBalance(original, history, 1n), /already been claimed/);
assert.throws(() => reassignFirmBalance({ ...original, claims: {} }, history, 0n), /source root/);
assert.throws(() => reassignFirmBalance(original, { ...history, incentives: [] }, 0n), /historical distribution/);

// A regular round on this parent credits the borrower with both historical and new DOLA.
const newRewards: Distribution = {
    timestamp: r.timestamp + 100000, blockNumber: r.blockNumber + 10000, incentives: [{
        ...entry, distribution: { incentiveId: 9999, amountToDistribute: 7n, incentivePerSecond: 1n },
        users: [{ user: r.beneficiary, amount: "7", share: "100.000000", balance: "1" }],
    }],
};
const next = createCombineDistribution(newRewards, corrected);
assert.equal(next[r.beneficiary][r.token], (r.amount + 7n).toString());
assert.equal(next[r.escrow]?.[r.token], undefined);
console.log("PASS: the published #2601 parent is corrected once, preserves all other pairs and combines with regular rewards");
