import fs from "fs";
import path from "path";
import { Address, getAddress } from "viem";
import { mainnet } from "viem/chains";

import { getClient } from "../utils/rpc";
import { getDistribution } from "../utils/distribution";
import { getLastDistributionsData } from "../utils/distributionData";
import { generateMerkleTree, writeMerkle, writeLastMerkle } from "../utils/merkle";
import { safeParse } from "../utils/parse";
import { expandWrapperAllocations } from "../integrations/expand";
import { registry } from "../integrations/registry";
import { MorphoIntegration } from "../integrations/morpho";
import { MerkleData } from "../interfaces/MerkleData";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";

const WRAPPER = getAddress("0x3B855AA8CC56a3cBd5dBb5456F5A13Ce86AA0fe8") as Address;
const VAULT = getAddress("0x4fdb3cb3DBD6D24B64276645c1ADCb85cbB39dC6") as Address;
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") as Address;
const INCENTIVE_ID = 309;

const AFFECTED_TIMESTAMPS = [
    1773965255, 1773987239, 1774008335, 1774030103, 1774051595,
    1774073303, 1774094579, 1774116539, 1774137995, 1774160003,
    1774180991, 1774202639, 1774224491, 1774246823, 1774267811,
    1774289603, 1774310831, 1774339583, 1774354271, 1774376111,
    1774397279, 1774419539, 1774440599,
];

const DATA_DIR = path.resolve(__dirname, "../../data");
const LAST_MERKLE_PATH = path.resolve(DATA_DIR, "last_merkle.json");

const readGaugeWindow = (ts: number): { startTimestamp: number; endTimestamp: number } => {
    const gaugePath = path.resolve(DATA_DIR, `distributions/${ts}/gauges/${VAULT}.json`);
    const gauge = safeParse(fs.readFileSync(gaugePath, { encoding: "utf-8" }));
    const window = gauge.windows.find((w: any) => w.incentiveId === INCENTIVE_ID);
    if (!window) {
        console.error(`No gauge window for incentive ${INCENTIVE_ID} at ts=${ts}`);
        process.exit(1);
    }
    return { startTimestamp: window.startTimestamp, endTimestamp: window.endTimestamp };
};

const main = async () => {
    console.log("=== Fix wrapper distributions ===\n");

    // Setup
    const client = await getClient(mainnet.id);
    const blockTimestampCache = new Map<string, number>();

    registry.register(new MorphoIntegration(client));
    const wrapperMap = await registry.buildWrapperMap();

    if (!wrapperMap.has(WRAPPER)) {
        console.error(`Wrapper ${WRAPPER} not found in registry`);
        process.exit(1);
    }

    // ── Passe 1: compute per-depositor deltas across all 23 distributions ──

    console.log(`\n── Passe 1: Computing deltas for ${AFFECTED_TIMESTAMPS.length} distributions ──\n`);

    const depositorDeltas = new Map<Address, bigint>();
    let totalWrapperRemoved = 0n;

    for (const ts of AFFECTED_TIMESTAMPS) {
        const dist = getDistribution(ts);
        const { startTimestamp, endTimestamp } = readGaugeWindow(ts);

        // Find the incentive for our vault + incentive ID
        const incentive = dist.incentives.find(
            (inc) =>
                getAddress(inc.vault) === VAULT &&
                inc.distribution.incentiveId === INCENTIVE_ID,
        );
        if (!incentive) {
            console.warn(`  ⚠️ ts=${ts}: no matching incentive, skipping`);
            continue;
        }

        // Find the wrapper's allocation
        const wrapperUser = incentive.users.find(
            (u) => getAddress(u.user) === WRAPPER,
        );
        if (!wrapperUser) {
            console.warn(`  ⚠️ ts=${ts}: wrapper not in users, skipping`);
            continue;
        }

        const wrapperAmount = BigInt(wrapperUser.amount);
        totalWrapperRemoved += wrapperAmount;

        const distBlockNumber = BigInt(dist.blockNumber);
        console.log(`  ts=${ts} block=${distBlockNumber} window=[${startTimestamp}, ${endTimestamp}] wrapperAmount=${wrapperAmount}`);

        // Build original amounts BEFORE expansion (expand mutates user objects in-place)
        const originalAmounts = new Map<Address, bigint>();
        for (const u of incentive.users) {
            if (getAddress(u.user) === WRAPPER) continue;
            originalAmounts.set(getAddress(u.user) as Address, BigInt(u.amount));
        }

        // Run expansion using the original distribution's block number
        const expandedUsers = await expandWrapperAllocations(
            client,
            incentive.users,
            wrapperMap,
            startTimestamp,
            endTimestamp,
            distBlockNumber,
            blockTimestampCache,
        );

        // The wrapper should no longer be in expandedUsers
        const stillHasWrapper = expandedUsers.some(
            (u) => getAddress(u.user) === WRAPPER,
        );
        if (stillHasWrapper) {
            console.error(`  ❌ ts=${ts}: wrapper still present after expansion`);
            process.exit(1);
        }

        for (const u of expandedUsers) {
            const addr = getAddress(u.user) as Address;
            const expandedAmount = BigInt(u.amount);
            const originalAmount = originalAmounts.get(addr) ?? 0n;
            const delta = expandedAmount - originalAmount;

            if (delta > 0n) {
                const existing = depositorDeltas.get(addr) ?? 0n;
                depositorDeltas.set(addr, existing + delta);
            }
        }
    }

    console.log(`\n── Passe 1 results ──`);
    console.log(`  Total wrapper removed: ${totalWrapperRemoved}`);
    console.log(`  Depositors to credit: ${depositorDeltas.size}`);

    const totalDeltaSum = Array.from(depositorDeltas.values()).reduce((a, b) => a + b, 0n);
    console.log(`  Sum of deltas: ${totalDeltaSum}`);

    if (totalDeltaSum !== totalWrapperRemoved) {
        console.error(`  ❌ INVARIANT VIOLATED: sum(deltas)=${totalDeltaSum} != wrapperRemoved=${totalWrapperRemoved}`);
        process.exit(1);
    }
    console.log(`  ✅ Invariant OK: sum(deltas) == wrapperRemoved`);

    // Print top depositors
    const sorted = Array.from(depositorDeltas.entries())
        .sort((a, b) => Number(b[1] - a[1]));
    console.log(`\n  Top depositors:`);
    for (const [addr, amount] of sorted.slice(0, 10)) {
        console.log(`    ${addr}  +${amount}`);
    }

    // ── Passe 2: patch last merkle ──

    console.log(`\n── Passe 2: Patching last merkle ──\n`);

    // Backup
    const backupPath = LAST_MERKLE_PATH + ".bak";
    fs.copyFileSync(LAST_MERKLE_PATH, backupPath);
    console.log(`  Backup saved to ${backupPath}`);

    const merkle = safeParse(
        fs.readFileSync(LAST_MERKLE_PATH, { encoding: "utf-8" }),
    ) as MerkleData;

    const oldRoot = merkle.merkleRoot;
    console.log(`  Old merkle root: ${oldRoot}`);

    // Verify wrapper is present
    const wrapperClaim = merkle.claims[WRAPPER];
    if (!wrapperClaim?.tokens?.[USDC]) {
        console.error(`  ❌ Wrapper ${WRAPPER} not found in last_merkle.json for USDC`);
        process.exit(1);
    }

    const wrapperMerkleAmount = BigInt(wrapperClaim.tokens[USDC].amount);
    console.log(`  Wrapper USDC in merkle: ${wrapperMerkleAmount}`);

    // Convert merkle claims to UniversalMerkle format for regeneration
    const universal: UniversalMerkle = {};

    for (const [address, claim] of Object.entries(merkle.claims)) {
        const addr = getAddress(address);
        if (addr === WRAPPER) {
            // Remove wrapper's USDC claim; keep other tokens if any
            universal[addr] = {};
            for (const [token, tokenClaim] of Object.entries(claim.tokens)) {
                const normalizedToken = getAddress(token);
                if (normalizedToken === USDC) continue; // skip USDC
                universal[addr][normalizedToken] = tokenClaim.amount.toString();
            }
            // Remove entirely if no tokens left
            if (Object.keys(universal[addr]).length === 0) {
                delete universal[addr];
            }
            continue;
        }

        universal[addr] = {};
        for (const [token, tokenClaim] of Object.entries(claim.tokens)) {
            universal[addr][getAddress(token)] = tokenClaim.amount.toString();
        }
    }

    // Add depositor deltas
    for (const [depositor, delta] of depositorDeltas.entries()) {
        const addr = getAddress(depositor);
        if (!universal[addr]) {
            universal[addr] = {};
        }

        const existing = BigInt(universal[addr][USDC] || "0");
        universal[addr][USDC] = (existing + delta).toString();
    }

    // Regenerate merkle tree
    console.log(`  Regenerating merkle tree...`);
    const newMerkle = generateMerkleTree(universal);

    // Normalize addresses
    newMerkle.claims = Object.fromEntries(
        Object.entries(newMerkle.claims).map(([address, claim]) => [
            getAddress(address),
            claim,
        ]),
    );

    console.log(`  New merkle root: ${newMerkle.merkleRoot}`);

    // Verify wrapper is gone
    if (newMerkle.claims[WRAPPER]?.tokens?.[USDC]) {
        console.error(`  ❌ Wrapper still in new merkle!`);
        process.exit(1);
    }
    console.log(`  ✅ Wrapper removed from merkle`);

    // Write
    const distData = getLastDistributionsData();
    const lastTimestamp = distData[distData.length - 1].timestamp;

    writeLastMerkle(newMerkle);
    writeMerkle(lastTimestamp, newMerkle);

    console.log(`\n=== Done ===`);
    console.log(`  Old root: ${oldRoot}`);
    console.log(`  New root: ${newMerkle.merkleRoot}`);
    console.log(`  Wrapper USDC removed: ${wrapperMerkleAmount}`);
    console.log(`  Depositors credited: ${depositorDeltas.size}`);
    console.log(`  Total redistributed: ${totalDeltaSum}`);
};

void main();
