import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { getAddress } from "viem";
import type { Distribution } from "../interfaces/Distribution";
import { applyPmusdRecovery, readPmusdSurplus } from "../recovery/pmusd";
import { createCombineDistribution, generateMerkleTree } from "../utils/merkle";
import { safeParse, safeStringify } from "../utils/parse";

const token = getAddress("0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf");
const manager = getAddress("0x52ea58f4fc3ced48fa18e909226c1f8a0ef887dc");
const total = 353239532329539949908n;
const parent = { blockNumber: 26497442, timestamp: 1795672871, sentOnchain: true };
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
    const baseline = path.join(dir, "distributions", String(parent.timestamp), "merkle.json");
    fs.mkdirSync(path.dirname(baseline), { recursive: true });
    fs.writeFileSync(baseline, JSON.stringify({ merkleRoot: "0x076a2ce306b71f0a9623397170baa9101a42cacc16d3a2ed3ebf6418f1692b31" }));
    fs.writeFileSync(index, safeStringify(pending ? [parent, next] : [parent]));
    if (pending) {
        fs.mkdirSync(path.dirname(round), { recursive: true });
        fs.writeFileSync(round, safeStringify({ timestamp: next.timestamp, blockNumber: next.blockNumber, incentives: [regular] }));
    }
    const apply = (surplus = total) => applyPmusdRecovery(dir,
        async () => ({ number: BigInt(next.blockNumber), timestamp: BigInt(next.timestamp) }),
        async block => { assert.equal(block, BigInt(next.blockNumber)); return surplus; });
    return { apply, dir, index, round, baseline };
}

test("a pending round credits the replayed vault allocations and keeps the paid manager leaf", async t => {
    const { apply, index, round } = fixture(t, true);
    const before = fs.readFileSync(round, "utf8");
    await apply(total - 1n);
    assert.equal(fs.readFileSync(round, "utf8"), before);
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
    assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), [parent, next]);
});

test("a pending credit must still be funded on retry and is applied only once", async t => {
    const { apply, round, index } = fixture(t, true);
    await apply();
    const allocations = fs.readFileSync(round, "utf8");
    await assert.rejects(apply(total - 1n), /refund missing/i);
    await apply(total + 1n);
    assert.equal(fs.readFileSync(round, "utf8"), allocations);
    assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), [parent, next]);
});

test("no ordinary rewards still creates one recovery round, with no payment on the next run", async t => {
    const { apply, dir, round, index } = fixture(t, false);
    await apply(0n);
    assert.equal(fs.existsSync(round), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), [parent]);
    await apply();
    assert.equal(JSON.parse(fs.readFileSync(round, "utf8")).incentives.length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), [parent, next]);
    const later = { ...next, timestamp: next.timestamp + 12, blockNumber: next.blockNumber + 1 };
    const nextIndex = [parent, { ...next, sentOnchain: true }, later];
    const laterRound = path.join(path.dirname(path.dirname(round)), String(later.timestamp), "distribution.json");
    const ordinaryRound = { timestamp: later.timestamp, blockNumber: later.blockNumber, incentives: [regular] };
    fs.mkdirSync(path.dirname(laterRound), { recursive: true });
    fs.writeFileSync(laterRound, safeStringify(ordinaryRound));
    fs.writeFileSync(index, safeStringify(nextIndex));
    const noRpc = async () => assert.fail("an exported recovery must not query the RPC");
    await applyPmusdRecovery(dir, noRpc, noRpc);
    assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), nextIndex);
    assert.deepEqual(JSON.parse(fs.readFileSync(laterRound, "utf8")), ordinaryRound);
});

test("an absent or unrelated history is skipped and an inconsistent production anchor is rejected", async t => {
    const { dir, index, baseline, round } = fixture(t, true);
    const before = fs.readFileSync(round, "utf8");
    const noRpc = async () => assert.fail("history must be checked before funding");
    const apply = () => applyPmusdRecovery(dir, noRpc, noRpc);
    fs.unlinkSync(index);
    await apply();
    assert.equal(fs.existsSync(index), false);
    for (const history of [[], [next], [{ ...parent, sentOnchain: false }]]) {
        fs.writeFileSync(index, JSON.stringify(history));
        await apply();
        assert.deepEqual(JSON.parse(fs.readFileSync(index, "utf8")), history);
    }
    fs.writeFileSync(index, JSON.stringify([parent, next]));
    fs.writeFileSync(baseline, JSON.stringify({ merkleRoot: "0x00" }));
    await assert.rejects(apply(), /anchor|production history/i);
    assert.equal(fs.readFileSync(round, "utf8"), before);
});

test("surplus reserves new pmUSD campaigns and reconciles claims and balance at the same block", async () => {
    const blockNumber = BigInt(next.blockNumber);
    const baseline = generateMerkleTree({ [manager]: { [token]: "100" }, [regular.vault]: { [otherToken]: "10" } });
    let activeRoot = baseline.merkleRoot;
    const campaign = (reward: string, chain: bigint, sender: string, amount: bigint) =>
        [regular.vault, reward, 300n, 0n, 300n, chain, sender, amount, manager];
    const newCampaigns = [
        campaign(token, 1n, manager, 800n),
        campaign(token, 42161n, "0x06Ab7052b00d038F8EeF33B267C23b5154cE8cDc", 200n),
        campaign(token, 42161n, manager, 5000n),
        campaign(otherToken, 1n, manager, 7000n),
    ];
    const grossAtAnchor = 71679499055389355574629n;
    let balance = grossAtAnchor + 1000n - 40n;
    type Call = { functionName: string; args?: readonly unknown[] };
    const result = ({ functionName, args }: Call) => {
        switch (functionName) {
            case "root": return activeRoot;
            case "balanceOf": return balance;
            case "nbIncentives": return 2610n + BigInt(newCampaigns.length);
            case "incentives": return newCampaigns[Number(args[0]) - 2610];
            case "claimed":
                assert.deepEqual(args, [manager, token]);
                return 40n;
            default: assert.fail(`Unexpected contract read: ${functionName}`);
        }
    };
    const client = {
        readContract: async (call: Call & { blockNumber: bigint }) => {
            assert.equal(call.blockNumber, blockNumber);
            return result(call);
        },
        multicall: async (call: { contracts: Call[]; blockNumber: bigint; allowFailure: boolean }) => {
            assert.equal(call.blockNumber, blockNumber);
            assert.equal(call.allowFailure, false);
            return call.contracts.map(result);
        },
    } as unknown as Parameters<typeof readPmusdSurplus>[1];
    const surplus = () => readPmusdSurplus(baseline, client, blockNumber);
    assert.equal(await surplus(), 0n);
    balance += total;
    assert.equal(await surplus(), total);
    activeRoot = "0x00";
    await assert.rejects(surplus(), /snapshot|root/i);
});
