import assert from "node:assert/strict";
import type { Distribution } from "../interfaces/Distribution";
import type { SerializedEarnedEntry } from "../interfaces/Breakdown";
import type { MerkleData } from "../interfaces/MerkleData";
import { buildFirmRecoveryTrees, FIRM_RECOVERY, repairFirmDistribution, repairFirmEarned } from "../recovery/firm";
import { generateMerkleTree } from "../utils/merkle";
import { safeParse, safeStringify } from "../utils/parse";

const r = FIRM_RECOVERY;
const otherToken = "0x1111111111111111111111111111111111111111";
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

const original = generateMerkleTree({
    [r.escrow]: { [otherToken]: "12", [r.token]: r.amount.toString() },
    [r.beneficiary]: { [r.token]: "44", [otherToken]: "13" },
    [otherUser]: { [r.token]: "33" },
});
const originalJson = JSON.stringify(original);
const { withdrawn, credited } = buildFirmRecoveryTrees(original, window, 0n);
function totalDola(tree: MerkleData): bigint {
    return Object.values(tree.claims).reduce((sum, claim) => sum + BigInt(claim.tokens[r.token]?.amount ?? 0), 0n);
}
assert.equal(totalDola(withdrawn), totalDola(original) - r.amount);
assert.equal(totalDola(credited), totalDola(original));
assert.equal(withdrawn.claims[r.beneficiary].tokens[r.token].amount, "44");
assert.equal(credited.claims[r.beneficiary].tokens[r.token].amount, (44n + r.amount).toString());
for (const stage of [withdrawn, credited]) {
    assert.equal(stage.claims[r.escrow].tokens[r.token], undefined);
    assert.equal(stage.claims[r.escrow].tokens[otherToken].amount, "12");
    assert.equal(stage.claims[r.beneficiary].tokens[otherToken].amount, "13");
    assert.equal(stage.claims[otherUser].tokens[r.token].amount, "33");
    assert.notEqual(stage.merkleRoot, original.merkleRoot);
}
assert.notEqual(withdrawn.merkleRoot, credited.merkleRoot);
assert.equal(JSON.stringify(original), originalJson);
assert.deepEqual(buildFirmRecoveryTrees(safeParse(originalJson), safeParse(safeStringify(repaired)), 0n), { withdrawn, credited });
assert.throws(() => buildFirmRecoveryTrees(credited, repaired, 0n), /escrow cumulative/);
assert.throws(() => buildFirmRecoveryTrees(withdrawn, window, 0n), /escrow cumulative/);
assert.throws(() => buildFirmRecoveryTrees(original, window, 1n), /already been claimed/);
assert.throws(() => buildFirmRecoveryTrees({ ...original, merkleRoot: credited.merkleRoot }, window, 0n), /source root/);
const excess = generateMerkleTree({ [r.escrow]: { [r.token]: (r.amount + 1n).toString() } });
assert.throws(() => buildFirmRecoveryTrees(excess, window, 0n), /escrow cumulative/);

// The affected historical snapshots have no previous DOLA entry for the borrower.
const noBorrower = generateMerkleTree({ [r.escrow]: { [r.token]: r.amount.toString() }, [otherUser]: { [r.token]: "1" } });
const stages = buildFirmRecoveryTrees(noBorrower, window, 0n);
assert.equal(stages.withdrawn.claims[r.escrow], undefined);
assert.equal(stages.withdrawn.claims[r.beneficiary], undefined);
assert.equal(stages.credited.claims[r.beneficiary].tokens[r.token].amount, r.amount.toString());
console.log("PASS: both FiRM recovery stages preserve unrelated entitlements and reject claimed, ambiguous and repeated corrections");
