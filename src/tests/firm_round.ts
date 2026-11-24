import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Distribution, IncentiveDistribution } from "../interfaces/Distribution";
import type { DistributionData } from "../interfaces/DistributionData";
import type { MerkleData } from "../interfaces/MerkleData";
import { FIRM_RECOVERY as r } from "../recovery/firm";
import { prepareFirmRecovery } from "../recovery/firm_round";
import { createCombineDistribution, generateMerkleTree } from "../utils/merkle";
import { safeStringify } from "../utils/parse";

const parentRound = { blockNumber: 26484884, timestamp: 1795521683, sentOnchain: true };
const originalRound = { blockNumber: r.blockNumber, timestamp: r.timestamp, sentOnchain: true };
const data = path.resolve(__dirname, "../../data");
const relativeHistory = `distributions/${r.timestamp}/distribution.json`;
const parent: MerkleData = JSON.parse(fs.readFileSync(path.join(data, "distributions", String(parentRound.timestamp), "merkle.json"), "utf8"));
const originalWindow: Distribution = JSON.parse(fs.readFileSync(path.join(data, relativeHistory), "utf8"));
// The on-disk history may already have been attributed to the borrower on a later production run.
const initial = originalWindow.incentives.find(incentive => incentive.distribution.incentiveId === r.incentiveId)!.users[0];
initial.user = r.escrow;
delete initial.firmEscrows;
delete initial.source;
assert.equal(parent.merkleRoot, r.parentRoot);

async function test(dir: string, hasNewRewards: boolean) {
    const file = (relative: string) => path.join(dir, relative);
    const read = <T>(relative: string): T => JSON.parse(fs.readFileSync(file(relative), "utf8"));
    const write = (relative: string, object: unknown) => {
        fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
        fs.writeFileSync(file(relative), safeStringify(object));
    };
    const entry = { timestamp: r.timestamp, vault: r.vault, amount: r.amount.toString(), source: "direct" };
    const index: DistributionData[] = [originalRound, parentRound];
    write(relativeHistory, originalWindow);
    write("distribution.json", index);
    write("breakdown/meta.json", { lastProcessedTimestamp: parentRound.timestamp });
    write("breakdown/earned.json", { [r.escrow + "-" + r.token]: [entry] });

    const block = { number: BigInt(parentRound.blockNumber + 100), timestamp: BigInt(parentRound.timestamp + 1200) };
    const next = { blockNumber: Number(block.number), timestamp: Number(block.timestamp), sentOnchain: false };
    let root: string = parent.merkleRoot;
    let claimed = 0n;
    let reads = 0;
    const rpc = {
        getBlock: async ({ blockTag }) => {
            reads++;
            assert.equal(blockTag, "latest");
            return block;
        },
        readContract: async ({ functionName, args, blockNumber }) => {
            assert.equal(blockNumber, block.number);
            if (functionName === "root") return root;
            assert.equal(functionName, "claimed");
            assert.deepEqual(args, [r.escrow, r.token]);
            return claimed;
        },
    } as unknown as Parameters<typeof prepareFirmRecovery>[2];
    const prepare = (tree: MerkleData) => prepareFirmRecovery(dir, tree, rpc);

    // All other parents and a previously paid escrow stay on the ordinary path.
    assert.equal(await prepare({ merkleRoot: "0xabcd", claims: {} }), undefined);
    assert.equal(reads, 0);
    claimed = r.amount;
    assert.equal(await prepare(parent), undefined);
    assert.deepEqual(read("distribution.json"), index);
    claimed = 1n;
    await assert.rejects(prepare(parent), /claimed/);
    claimed = 0n;
    root = "0x1234";
    await assert.rejects(prepare(parent), /root changed/);
    root = parent.merkleRoot;

    const recovery = (await prepare(parent))!;
    assert.deepEqual(read(relativeHistory), originalWindow);
    assert.equal(recovery.sourceRoot, parent.merkleRoot);
    const incentives: IncentiveDistribution[] = hasNewRewards ? [{
        vault: r.vault, token: { address: r.token, decimals: 18, symbol: "DOLA" },
        distribution: { incentiveId: 3000, amountToDistribute: 123n, incentivePerSecond: 1n },
        users: [{ user: r.beneficiary, amount: "123", balance: "23", share: "100.000000", source: "firm" }],
    }] : [];
    const relativeNext = `distributions/${next.timestamp}/distribution.json`;
    if (hasNewRewards) {
        write("distribution.json", [...index, next]);
        // A real pending distribution occupies the timestamp when this is called.
        write(relativeNext, { timestamp: next.timestamp, blockNumber: next.blockNumber, incentives });
    }
    recovery.ensurePendingRound();
    recovery.ensurePendingRound();
    assert.deepEqual(read("distribution.json"), [...index, next]);
    const pending = read<Distribution>(relativeNext);
    assert.deepEqual(pending.incentives, JSON.parse(safeStringify(incentives)));
    const combined = createCombineDistribution(pending, recovery.baseline);
    const candidate = generateMerkleTree(combined);
    assert.equal(candidate.claims[r.beneficiary].tokens[r.token].amount, (r.amount + (hasNewRewards ? 123n : 0n)).toString());
    assert.equal(candidate.claims[r.escrow]?.tokens[r.token], undefined);
    assert.equal((await prepare(parent))!.baseline.merkleRoot, recovery.baseline.merkleRoot);

    claimed = r.amount;
    await assert.rejects(recovery.confirmUnclaimed(), /claimed/);
    claimed = 0n;
    root = "0x1234";
    await assert.rejects(recovery.confirmUnclaimed(), /root changed/);
    root = parent.merkleRoot;
    await recovery.confirmUnclaimed();
    recovery.repairHistory();
    recovery.repairHistory();
    assert.deepEqual(read("breakdown/earned.json"), { [r.beneficiary + "-" + r.token]: [{ ...entry, source: "firm" }] });
    assert.equal(read<Distribution>(relativeHistory).incentives.find(i => i.distribution.incentiveId === r.incentiveId)!.users[0].user, r.beneficiary);
    assert.equal(await prepare(candidate), undefined);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "firm-round-"));
Promise.all([test(path.join(temp, "normal"), true), test(path.join(temp, "empty"), false)])
    .then(() => console.log("FiRM single-root recovery rounds passed"))
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
