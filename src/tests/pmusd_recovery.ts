import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { getAddress } from "viem";
import type { Distribution } from "../interfaces/Distribution";
import { applyPmusdRecovery } from "../recovery/pmusd";
import { createCombineDistribution, generateMerkleTree } from "../utils/merkle";
import { safeParse, safeStringify } from "../utils/parse";

const token = getAddress("0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf");
const manager = getAddress("0x52ea58f4fc3ced48fa18e909226c1f8a0ef887dc");
const total = 353239532329539949908n;
const parent = { blockNumber: 26490000, timestamp: 1795580000, sentOnchain: true };
const next = { blockNumber: parent.blockNumber + 10, timestamp: parent.timestamp + 120, sentOnchain: false };
const otherToken = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const regular = {
    vault: getAddress("0x7d3CDe9cCf0109423E672c17bD36481CF8CE437D"),
    token: { address: otherToken, decimals: 6, symbol: "USDC" },
    distribution: { incentiveId: 999, incentivePerSecond: "1", amountToDistribute: "25" },
    users: [{ user: manager, amount: "25", balance: "1", share: "100.000000" }],
};

function digest(pairs: [string, string][]) {
    const lines = pairs.map(([user, amount]) => `${user.toLowerCase()},${amount}\n`).sort();
    return createHash("sha256").update(lines.join("")).digest("hex");
}

function fixture(t: TestContext, pending: boolean) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmusd-recovery-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const index = path.join(dir, "distribution.json");
    const round = path.join(dir, "distributions", String(next.timestamp), "distribution.json");
    const initialIndex = pending ? [parent, next] : [parent];
    fs.writeFileSync(index, safeStringify(initialIndex));
    if (pending) {
        fs.mkdirSync(path.dirname(round), { recursive: true });
        fs.writeFileSync(round, safeStringify({ timestamp: next.timestamp, blockNumber: next.blockNumber, incentives: [regular] }));
    }
    const apply = () => applyPmusdRecovery(dir, async () => ({ number: BigInt(next.blockNumber), timestamp: BigInt(next.timestamp) }));
    return { apply, index, round, initialIndex };
}

test("a pending round credits the replayed vault allocations and keeps the paid manager leaf", async t => {
    const { apply, index, round } = fixture(t, true);
    await apply();
    const json = fs.readFileSync(round, "utf8");
    assert.deepEqual(JSON.parse(json).incentives.filter(row => !row.distribution.recovery), [regular]);
    const distribution: Distribution = safeParse(json);
    const corrections = distribution.incentives.filter(row => row.distribution.recovery === "pmusd-twab");
    corrections.sort((a, b) => a.distribution.incentiveId - b.distribution.incentiveId);
    assert.deepEqual(corrections.map(row => [row.distribution.incentiveId, row.vault, row.distribution.amountToDistribute,
        digest(row.users.map(u => [u.user, u.amount]))]), [
        [341, "0xD0fD4B4141dE8D021Df1C15e6eAFde2d276fe116", 178789760479041904068n, "69698d833fa943090547e5aa76abc6b462f4c6dbb2bbe724d28ac9d9a0ad6532"],
        [342, "0x7d3CDe9cCf0109423E672c17bD36481CF8CE437D", 174449771850498045840n, "031f5e89172b9d1b3582a62561050016f7a4b6fb2ca078fc682ebf9c19601d92"],
    ]);
    for (const row of corrections) {
        assert.equal(row.token.address, token);
        assert.ok(row.users.every(u => u.source === "direct" && BigInt(u.amount) > 0n));
        assert.equal(row.users.reduce((sum, u) => sum + BigInt(u.amount), 0n), row.distribution.amountToDistribute);
    }
    const baseline = generateMerkleTree({ [manager]: { [token]: total.toString(), [otherToken]: "7" } });
    const combined = createCombineDistribution(distribution, baseline);
    assert.deepEqual(combined[manager], { [token]: total.toString(), [otherToken]: "32" });
    const beneficiaries = Object.entries(combined).filter(([user]) => user !== manager);
    assert.equal(beneficiaries.length, 190);
    assert.equal(digest(beneficiaries.map(([user, amounts]) => [user, amounts[token]])),
        "59badc6fa6c2f9c7a8c12d8c0eceae894b534a452786df7c8e23eb955eb7a470");
    assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), [parent, { ...next, pmusdRecovery: true }]);
});

test("a retry after writing allocations restores the missing index marker without paying twice", async t => {
    const { apply, round, index, initialIndex } = fixture(t, true);
    await apply();
    const allocations = fs.readFileSync(round, "utf8");
    fs.writeFileSync(index, safeStringify(initialIndex));
    await apply();
    assert.deepEqual(JSON.parse(fs.readFileSync(round, "utf8")), JSON.parse(allocations));
    assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), [parent, { ...next, pmusdRecovery: true }]);
});

test("no ordinary rewards still creates one recovery round, with no payment on the next run", async t => {
    const { apply, round, index } = fixture(t, false);
    await apply();
    assert.equal(JSON.parse(fs.readFileSync(round, "utf8")).incentives.length, 2);
    const marked = { ...next, pmusdRecovery: true };
    assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), [parent, marked]);
    const later = { ...next, timestamp: next.timestamp + 12, blockNumber: next.blockNumber + 1 };
    const nextIndex = [parent, { ...marked, sentOnchain: true }, later];
    const laterRound = path.join(path.dirname(path.dirname(round)), String(later.timestamp), "distribution.json");
    const ordinaryRound = { timestamp: later.timestamp, blockNumber: later.blockNumber, incentives: [regular] };
    fs.mkdirSync(path.dirname(laterRound), { recursive: true });
    fs.writeFileSync(laterRound, safeStringify(ordinaryRound));
    fs.writeFileSync(index, safeStringify(nextIndex));
    await apply();
    assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), nextIndex);
    assert.deepEqual(JSON.parse(fs.readFileSync(laterRound, "utf8")), ordinaryRound);
});
