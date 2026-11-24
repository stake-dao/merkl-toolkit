import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIRM_RECOVERY as r } from "../recovery/firm";
import { prepareFirmRecovery } from "../recovery/firm_round";
import { createCombineDistribution, generateMerkleTree } from "../utils/merkle";

async function test(dir: string, claimDuringPublication: boolean) {
    const file = (...names: string[]) => path.join(dir, ...names);
    const read = (name: string) => JSON.parse(fs.readFileSync(file(name), "utf8"));
    const data = path.resolve(__dirname, "../../data");
    const history = `distributions/${r.timestamp}/distribution.json`;
    fs.mkdirSync(path.dirname(file(history)), { recursive: true });
    fs.copyFileSync(path.join(data, history), file(history));
    // Use an immutable published snapshot, including when the checkout has already adopted the repair.
    const before = generateMerkleTree({ [r.escrow]: { [r.token]: r.amount.toString() }, [r.vault]: { [r.token]: "9" } });
    const originalWindow = read(history);
    const row = originalWindow.incentives.find(i => i.distribution.incentiveId === r.incentiveId).users[0];
    row.user = r.escrow;
    delete row.source;
    delete row.firmEscrows;
    fs.writeFileSync(file(history), JSON.stringify(originalWindow));
    fs.writeFileSync(file("last_merkle.json"), JSON.stringify(before));
    fs.writeFileSync(file(`distributions/${r.timestamp}/merkle.json`), JSON.stringify(before));
    fs.writeFileSync(file("distribution.json"), JSON.stringify([{ timestamp: r.timestamp, blockNumber: r.blockNumber, sentOnchain: true }]));
    fs.mkdirSync(file("breakdown"));
    fs.writeFileSync(file("breakdown/meta.json"), JSON.stringify({ lastProcessedTimestamp: r.timestamp }));
    const entry = { timestamp: r.timestamp, vault: r.vault, amount: r.amount.toString(), source: "direct" };
    fs.writeFileSync(file("breakdown/earned.json"), JSON.stringify({ [r.escrow + "-" + r.token]: [entry] }));

    let root = before.merkleRoot;
    let claimed = 0n;
    let height = 1;
    const rpc = {
        getBlock: async ({ blockTag }) => {
            assert.equal(blockTag, "finalized");
            return { number: BigInt(r.blockNumber + height), timestamp: BigInt(r.timestamp + height * 12) };
        },
        readContract: async ({ functionName, args, blockNumber }) => {
            assert.equal(blockNumber, BigInt(r.blockNumber + height));
            if (functionName === "root") return root;
            assert.equal(functionName, "claimed");
            assert.deepEqual(args, [r.escrow, r.token]);
            return claimed;
        },
    } as unknown as Parameters<typeof prepareFirmRecovery>[2];
    const run = (baseline = read("last_merkle.json")) => prepareFirmRecovery(dir, baseline, rpc);
    assert(await run());
    const withdrawn = read("last_merkle.json");
    assert.equal(withdrawn.claims[r.escrow], undefined);
    assert.equal(withdrawn.claims[r.beneficiary], undefined);
    assert(await run(before)); // Replay interrupted between indexing the round and writing the candidate.
    assert.equal(read("distribution.json").length, 2);
    await assert.rejects(run(), /finalize/);
    root = withdrawn.merkleRoot;
    height++;
    claimed = 1n;
    await assert.rejects(run(), /already been claimed/);
    assert.equal(read("distribution.json").length, 2);
    assert.deepEqual(read(history), originalWindow);
    if (claimDuringPublication) {
        claimed = r.amount;
        assert(await run());
        assert.deepEqual(read("last_merkle.json"), before);
        assert.deepEqual(read(history), originalWindow);
        assert.equal(read("distribution.json")[2].firmRecovery.stage, "restore");
        assert(await run(withdrawn));
        root = before.merkleRoot;
        assert.equal(await run(), false);
        assert.equal(read("distribution.json").length, 3);
        return;
    }
    claimed = 0n;
    assert(await run());
    const credited = read("last_merkle.json");
    assert.equal(credited.claims[r.beneficiary].tokens[r.token].amount, r.amount.toString());
    assert.equal(credited.claims[r.escrow], undefined);
    assert.deepEqual(read("breakdown/earned.json"), { [r.beneficiary + "-" + r.token]: [{ ...entry, source: "firm" }] });
    assert(await run(withdrawn)); // Retry after the cache and history have already been migrated.
    assert.equal(read("distribution.json").length, 3);
    root = credited.merkleRoot;
    assert.equal(await run(), false);
    const index = read("distribution.json");
    const nextBaseline = read(`distributions/${index[2].timestamp}/merkle.json`);
    const next = createCombineDistribution({ timestamp: 0, blockNumber: 0, incentives: [] }, nextBaseline);
    assert.equal(next[r.beneficiary][r.token], r.amount.toString());
    assert.equal(next[r.escrow], undefined);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "firm-round-"));
Promise.all([test(path.join(dir, "unclaimed"), false), test(path.join(dir, "already-paid"), true)])
    .then(() => console.log("FiRM recovery publication rounds passed"))
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
