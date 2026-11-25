import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Address, getAddress, zeroAddress } from "viem";
import { getFirmEscrowOwners } from "../integrations/firm/registry";

const first = 16_155_758n;
const dbr = getAddress("0xAD038Eb671c44b853887A7E32528FaB35dC5D710");
const market = getAddress("0xCCfD76343a09F9B12347eFBCeAB8Df8b4191524E");
const user = getAddress("0x80c67fe70d7d6cc488782439fad381d8646640c4");
const escrow = getAddress("0x4b460cf00679cd0291048c75ca4c63d3ae830630");
const nextMarket = getAddress("0x000000000000000000000000000000000000002a");
const nextEscrow = getAddress("0x000000000000000000000000000000000000002b");
const unrelated = getAddress("0x000000000000000000000000000000000000002c");

async function testRegistry(cachePath: string) {
    const registrations = [
        { address: dbr, args: { market }, blockNumber: first + 4n },
        { address: dbr, args: { market: nextMarket }, blockNumber: first + 20n },
    ];
    const creations = [
        { address: market, args: { user, escrow }, blockNumber: first + 2n },
        { address: nextMarket, args: { user, escrow: nextEscrow }, blockNumber: first + 8n },
        { address: unrelated, args: { user, escrow: unrelated }, blockNumber: first + 1n },
    ];
    let getLogsCount = 0;
    let failingPage: bigint | undefined;
    const calls: { fromBlock: bigint; toBlock: bigint }[] = [];
    let invalidResult = false;
    const blockHashes = new Map<bigint, string>();
    const mock = {
        chain: { id: 1 },
        getBlock: async ({ blockNumber }) => ({ hash: blockHashes.get(blockNumber) ?? "0x01" }),
        getCode: async ({ blockNumber }) => blockNumber >= first ? "0x12" : undefined,
        getLogs: async ({ address, event, fromBlock, toBlock }) => {
            getLogsCount++;
            calls.push({ fromBlock, toBlock });
            assert(toBlock - fromBlock < 10_000n);
            if (fromBlock === failingPage) throw new Error("RPC page unavailable");
            const addresses = Array.isArray(address) ? address : [address];
            const events = event.name === "AddMarket" ? registrations : creations;
            return events.filter(e => addresses.includes(e.address) && e.blockNumber >= fromBlock && e.blockNumber <= toBlock);
        },
        multicall: async ({ contracts, blockNumber }) => contracts.map(({ address, functionName, args }) => {
            assert.equal(functionName, "escrows");
            const event = creations.find(e =>
                e.address === address && e.args.user === args[0] && e.blockNumber <= blockNumber,
            );
            return invalidResult ? zeroAddress : event?.args.escrow;
        }),
    };
    const ownersAt = (blockNumber: bigint) =>
        getFirmEscrowOwners(mock as unknown as Parameters<typeof getFirmEscrowOwners>[0], blockNumber, cachePath);

    assert.equal((await ownersAt(first - 1n)).size, 0);
    failingPage = first + 40_000n;
    await assert.rejects(ownersAt(failingPage), /RPC page unavailable/);
    assert(!fs.existsSync(cachePath), "A failed backfill must not leave a partial checkpoint");
    failingPage = undefined;
    const original = await ownersAt(first + 10n);
    assert.deepEqual(original, new Map([[escrow, user]]));
    assert(!original.has(nextEscrow), "An unregistered market must not redirect rewards");
    const coldCalls = getLogsCount;
    assert.deepEqual(await ownersAt(first + 10n), original);
    assert.equal(getLogsCount, coldCalls, "An already verified snapshot should reuse its checkpoint");

    invalidResult = true;
    const beforeFailure = fs.readFileSync(cachePath, "utf8");
    await assert.rejects(ownersAt(first + 22n), /Invalid FiRM escrow/);
    assert.equal(fs.readFileSync(cachePath, "utf8"), beforeFailure);

    invalidResult = false;
    const updated = await ownersAt(first + 22n);
    assert.deepEqual(updated, new Map<Address, Address>([[escrow, user], [nextEscrow, user]]));
    const beforeReplay = fs.readFileSync(cachePath, "utf8");
    assert.deepEqual(await ownersAt(first + 8n), original);
    assert.equal(fs.readFileSync(cachePath, "utf8"), beforeReplay, "Historical reads must not rewind the checkpoint");

    calls.length = 0;
    await ownersAt(first + 30n);
    assert(calls.every(call => call.fromBlock === first + 23n), "A daily run should only read new blocks");

    // Remove a now-orphaned registration. Its escrow must disappear on the new chain.
    blockHashes.set(first + 30n, "0x02");
    registrations.pop();
    assert.deepEqual(await ownersAt(first + 31n), original);
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "firm-registry-"));
    try {
        await testRegistry(path.join(directory, "index.json"));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    console.log("FiRM registry tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
