import assert from "node:assert/strict";
import { Address, getAddress } from "viem";
import { applyFirmEscrowAllocations } from "../2_distribution";
import { UserDistribution } from "../interfaces/Distribution";
import { describeSources, earnedPortions } from "../utils/breakdown";
import { safeParse, safeStringify } from "../utils/parse";

const escrow = getAddress("0x4b460cf00679cd0291048c75ca4c63d3ae830630");
const borrower = getAddress("0x80c67fe70d7d6cc488782439fad381d8646640c4");
const secondEscrow = getAddress("0x00000000000000000000000000000000000000aa");
const other = getAddress("0x00000000000000000000000000000000000000bb");
const owners = new Map([[escrow, borrower], [secondEscrow, borrower]]);
const morphoDepositors = new Set<string>();

// The actual holder weight and allocated DOLA from incentive 2601. Historical JSON may be
// read back through safeParse, which revives decimal amounts and balances as bigint.
const original: UserDistribution = {
    user: escrow,
    balance: "9743999999999999632233330889748257339183",
    share: "100.000000",
    amount: "36666666666666441888",
};
const [credited] = applyFirmEscrowAllocations([original], owners, BigInt(original.balance));
assert.deepEqual(credited, {
    ...original, user: borrower, source: "firm", firmEscrows: [{ escrow, amount: original.amount }],
});
assert.equal(original.user, escrow);
assert.deepEqual(earnedPortions(safeParse(safeStringify(credited)), morphoDepositors), [
    { amount: BigInt(original.amount), source: "firm" },
]);

// The personal allocation is already rounded by TWAB. Preserve it exactly when
// two escrows and a direct holding resolve to the same checksummed borrower.
const personal = { user: borrower.toLowerCase() as Address, balance: "1", share: "16.666666", amount: "1" };
const first = { ...personal, user: escrow, amount: "2" };
const second = { ...personal, user: secondEscrow, amount: "3" };
const unrelated = { ...personal, user: other, balance: "3", share: "50.000000", amount: "4" };
for (const rows of [[personal, first, second, unrelated], [first, second, unrelated, personal]]) {
    const users = applyFirmEscrowAllocations(rows, owners, 6n);
    assert.equal(users.length, 2);
    assert.deepEqual(users.find(u => u.user === other), unrelated);
    const combined = users.find(u => u.user === borrower)!;
    assert.deepEqual(combined, {
        user: borrower, amount: "6", balance: "3", share: "50.000000", source: "direct",
        firmEscrows: [{ escrow, amount: "2" }, { escrow: secondEscrow, amount: "3" }],
    });
    assert.deepEqual(earnedPortions(combined, morphoDepositors), [
        { amount: 1n, source: "direct" }, { amount: 5n, source: "firm" },
    ]);
    assert.equal(users.reduce((total, user) => total + BigInt(user.amount), 0n), 10n);
}

// Morpho-only positions carry zero direct holder weight after wrapper expansion.
const morpho = { ...personal, balance: "0", share: "0.000000", source: "morpho" as const };
const [mixed] = applyFirmEscrowAllocations([first, morpho], owners, 6n);
assert.deepEqual(earnedPortions(mixed, morphoDepositors), [
    { amount: 1n, source: "morpho" }, { amount: 2n, source: "firm" },
]);
assert.deepEqual(describeSources(new Set(["firm"])), { type: "firm" });
assert.deepEqual(describeSources(new Set(["morpho", "firm"])), { type: "both", sources: ["firm", "morpho"] });
assert.deepEqual(describeSources(new Set(["direct", "morpho"])), { type: "both" });
assert.deepEqual(earnedPortions({ ...morpho, source: undefined }, new Set([borrower.toLowerCase()])), [
    { amount: 1n, source: "morpho" },
]);
assert.throws(() => earnedPortions({ ...credited, amount: "1" }, morphoDepositors), /reconcile/);

// The zero-TWAB manager fallback is an intentional payment to the manager.
const manager = { ...original, balance: "0" };
assert.deepEqual(applyFirmEscrowAllocations([manager], owners, 0n), [manager]);
console.log("FiRM borrower allocations and breakdown passed");
