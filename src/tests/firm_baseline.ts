import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MerkleData } from "../interfaces/MerkleData";
import { buildFirmRecoveryTrees, FIRM_RECOVERY as r } from "../recovery/firm";
import { readPipelineBaseline } from "../recovery/firm_baseline";
import { generateMerkleTree } from "../utils/merkle";

async function verify(dir: string) {
    const write = (relative: string, data: unknown) => {
        const file = path.join(dir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data));
    };
    const historyPath = `distributions/${r.timestamp}/distribution.json`;
    const history = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../data", historyPath), "utf8"));
    const source = generateMerkleTree({ [r.escrow]: { [r.token]: r.amount.toString() }, [r.vault]: { [r.token]: "9" } });
    const { withdrawn, credited } = buildFirmRecoveryTrees(source, history, 0n);
    const sourceRow = { timestamp: r.timestamp, blockNumber: r.blockNumber, sentOnchain: true };
    const row = (stage: string, height: number) => ({
        timestamp: r.timestamp + height * 12, blockNumber: r.blockNumber + height, sentOnchain: true,
        firmRecovery: { stage, sourceTimestamp: r.timestamp, sourceRoot: source.merkleRoot },
    });
    const putTree = (timestamp: number, tree: MerkleData) => write(`distributions/${timestamp}/merkle.json`, tree);
    const withdrawal = row("withdraw", 1);
    const credit = row("credit", 2);
    const restore = row("restore", 2);
    let chain = 1;
    let active = source.merkleRoot;
    const rpc = { getChainId: async () => chain, readContract: async () => active } as unknown as Parameters<typeof readPipelineBaseline>[1];
    const run = () => readPipelineBaseline(dir, rpc);
    write(historyPath, history);
    putTree(sourceRow.timestamp, source);
    putTree(withdrawal.timestamp, withdrawn);
    write("distribution.json", [sourceRow, withdrawal]);
    write("last_merkle.json", withdrawn);
    assert.deepEqual(await run(), source);
    chain = 10;
    await assert.rejects(run(), /Wrong baseline RPC chain/);
    chain = 1;
    active = credited.merkleRoot;
    await assert.rejects(run(), /expected FiRM recovery parent/);
    active = source.merkleRoot;
    write("last_merkle.json", credited);
    await assert.rejects(run(), /candidate/);
    write("last_merkle.json", withdrawn);
    putTree(withdrawal.timestamp, credited);
    await assert.rejects(run(), /candidate/);
    putTree(withdrawal.timestamp, withdrawn);

    active = withdrawn.merkleRoot;
    write("distribution.json", [sourceRow, withdrawal, credit]);
    putTree(credit.timestamp, credited);
    write("last_merkle.json", credited);
    assert.deepEqual(await run(), withdrawn);
    const badProof = JSON.parse(JSON.stringify(credited));
    badProof.claims[r.beneficiary].tokens[r.token].proof = [];
    write("last_merkle.json", badProof);
    await assert.rejects(run(), /candidate/);

    write("distribution.json", [sourceRow, withdrawal, restore]);
    putTree(restore.timestamp, source);
    write("last_merkle.json", source);
    assert.deepEqual(await run(), withdrawn);
    putTree(withdrawal.timestamp, credited);
    await assert.rejects(run(), /withdrawal snapshot/);
    putTree(withdrawal.timestamp, withdrawn);
    write("distribution.json", [sourceRow, row("credit", 1), restore]);
    await assert.rejects(run(), /matching withdrawal/);

    write("distribution.json", [sourceRow]);
    await assert.rejects(run(), /adopt the confirmed recovery/);
    write(`recoveries/${withdrawn.merkleRoot}.json`, { sourceRoot: source.merkleRoot, merkle: withdrawn });
    assert.deepEqual(await run(), withdrawn, "Existing confirmed recovery adoption must remain available");
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "firm-baseline-"));
verify(dir).then(() => console.log("FiRM candidate baseline tests passed"))
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
