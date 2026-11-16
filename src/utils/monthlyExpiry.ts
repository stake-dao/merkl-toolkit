import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getAddress, parseAbi, PublicClient, zeroHash, zeroAddress } from "viem";
import { MERKL_CONTRACT } from "../constants";
import { MerkleData } from "../interfaces/MerkleData";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";
import { Distribution } from "../interfaces/Distribution";
import { getClient } from "./rpc";
import { merklAbi } from "../abis/Merkl";
import { generateMerkleTree } from "./merkle";

const TREASURY = "0x9EBBb3d59d53D6aD3FA5464f36c2E84aBb7cf5c1";
const ABI = parseAbi(["function root() view returns(bytes32)", "function pendingRoot() view returns(bytes32,bytes32,uint256)", "function claimed(address,address) view returns(uint256)"]);
export interface MonthlyJournal {
    version: 1;
    pool: "extra-1";
    revision: number;
    ledger: { root: string; distributor: string; chainId: number; checkpoint: { block: number; blockHash: string }; pairs: Record<string, { account: string; token: string; activeAmount: string; paid: string }> };
    merkle: MerkleData;
    adopted?: { reserve: Record<string, string> };
    publication?: unknown;
    execution?: unknown;
    cancelRequested?: boolean;
    cancelled?: boolean;
    creditedSources?: string[];
}

export async function readMonthlyJournal(): Promise<MonthlyJournal | undefined> {
    const response = await fetch("https://api.github.com/repos/stake-dao/bounties-report/contents/bounties-reports/monthly-expiry/extra-1.json?ref=main", { headers: { Accept: "application/vnd.github.raw+json" }, cache: "no-store" });
    if (response.status === 404) return;
    assert(response.ok, "monthly publication journal unavailable");
    const state = await response.json() as MonthlyJournal;
    assert(state.version === 1 && state.pool === "extra-1" && state.ledger.chainId === 1 && state.ledger.distributor === MERKL_CONTRACT, "monthly journal target mismatch");
    assert(!state.publication && !state.execution && !state.cancelRequested && !state.cancelled, "monthly publication requires reconciliation");
    assert.equal(state.merkle.merkleRoot, state.ledger.root, "monthly active artifact mismatch");
    return state;
}

/** All recorded campaigns, including undistributed future rewards, remain
 * reserved. Unexplained refunds/shortfalls must be reconciled, not netted with
 * user debt or expiry proceeds. Archives include this run's allocation once. */
export async function campaignReserves(client: PublicClient, blockNumber: bigint, directory = path.resolve(__dirname, "../../data/distributions")) {
    const count = await client.readContract({ address: MERKL_CONTRACT, abi: merklAbi, functionName: "nbIncentives", blockNumber, authorizationList: undefined });
    assert(count <= BigInt(Number.MAX_SAFE_INTEGER), "campaign count overflow");
    const incentives: { id: number; reward: string; amount: bigint }[] = [];
    for (let start = 0; start < Number(count); start += 150) {
        const ids = Array.from({ length: Math.min(150, Number(count) - start) }, (_, i) => start + i);
        const rows = await client.multicall({ contracts: ids.map(id => ({ address: MERKL_CONTRACT, abi: merklAbi, functionName: "incentives" as const, args: [BigInt(id)] })), blockNumber, allowFailure: false, authorizationList: undefined });
        rows.forEach((row, i) => { incentives.push({ id: ids[i], reward: getAddress(row[1]), amount: row[7] }); });
    }
    const allocated = new Map<number, bigint>();
    for (const folder of fs.readdirSync(directory).filter(name => /^\d+$/.test(name))) {
        const file = path.join(directory, folder, "distribution.json");
        if (!fs.existsSync(file)) continue;
        const distribution: Distribution = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const row of distribution.incentives) {
            assert(incentives.some(i => i.id === row.distribution.incentiveId && getAddress(i.reward) === getAddress(row.token.address)), "unknown campaign allocation");
            const amount = row.users.reduce((sum, user) => { assert(/^\d+$/.test(user.amount)); return sum + BigInt(user.amount); }, 0n);
            allocated.set(row.distribution.incentiveId, (allocated.get(row.distribution.incentiveId) ?? 0n) + amount);
        }
    }
    const reserves: Record<string, string> = {};
    for (const incentive of incentives) {
        if (incentive.reward === zeroAddress && incentive.amount === 0n) continue;
        const remaining = BigInt(incentive.amount) - (allocated.get(incentive.id) ?? 0n);
        assert(remaining >= 0n, "campaign allocations exceed funding");
        const token = getAddress(incentive.reward);
        reserves[token] = (BigInt(reserves[token] ?? "0") + remaining).toString();
    }
    return { reserves, campaignCount: count.toString() };
}

export async function prepareMonthlyPublication(state: MonthlyJournal, gains: UniversalMerkle, allocations: Distribution["incentives"], sources: string[]) {
    assert(sources.length && new Set(sources).size === sources.length && sources.every(id => !(state.creditedSources ?? []).includes(id)), "reward source already credited");
    const client = await getClient(1);
    const block = await client.getBlock();
    assert.equal(await client.getChainId(), 1, "publication RPC chain mismatch");
    assert.equal((await client.getBlock({ blockNumber: BigInt(state.ledger.checkpoint.block) })).hash, state.ledger.checkpoint.blockHash, "monthly checkpoint reorged");
    assert.equal(await client.readContract({ address: MERKL_CONTRACT, abi: ABI, functionName: "root", blockNumber: block.number! }), state.ledger.root, "unadopted extra publication");
    assert.equal((await client.readContract({ address: MERKL_CONTRACT, abi: ABI, functionName: "pendingRoot", blockNumber: block.number! }))[0], zeroHash, "extra root already pending");
    const amounts: UniversalMerkle = {};
    for (const pair of Object.values(state.ledger.pairs)) {
        amounts[pair.account] ??= {};
        amounts[pair.account][pair.token] = pair.activeAmount;
    }
    for (const [account, tokens] of Object.entries(gains)) {
        amounts[account] ??= {};
        for (const token of Object.keys(tokens)) amounts[account][token] ??= "0";
    }
    for (const token of Object.keys(state.adopted?.reserve ?? {})) {
        amounts[TREASURY] ??= {};
        amounts[TREASURY][token] ??= "0";
    }
    for (const [account, tokens] of Object.entries(amounts)) for (const [token, amount] of Object.entries(tokens)) {
        const claimed = await client.readContract({ address: MERKL_CONTRACT, abi: ABI, functionName: "claimed", args: [getAddress(account), getAddress(token)], blockNumber: block.number! });
        const base = BigInt(amount) > claimed ? BigInt(amount) : claimed;
        const credit = account === TREASURY ? BigInt(state.adopted?.reserve[token] ?? "0") : 0n;
        amounts[account][token] = (base + BigInt(gains[account]?.[token] ?? "0") + credit).toString();
    }
    const { reserves, campaignCount } = await campaignReserves(client, block.number!);
    for (const tokens of Object.values(amounts)) for (const token of Object.keys(tokens)) reserves[token] ??= "0";
    const merkle = generateMerkleTree(amounts);
    assert.equal((await client.getBlock({ blockNumber: block.number! })).hash, block.hash, "publication snapshot reorged");
    return { version: 1, pool: "extra-1", revision: state.revision, kind: state.adopted ? "settlement" : "ordinary", parent: state.ledger.root, merkle, gains, allocations, sources, reserves, campaignCount, checkpoint: { block: Number(block.number), blockHash: block.hash! }, ipfsHash: zeroHash };
}

/** Generation is not activation. Retain unsubmitted gains when a cut or a
 * failed publication intervenes, without applying their debt redirects twice. */
export function carryUnpublished(state: MonthlyJournal, gains: UniversalMerkle, allocations: Distribution["incentives"], source: string, previous?: { sources: string[]; gains: UniversalMerkle; allocations: Distribution["incentives"] }) {
    const sources = [source];
    const carried = structuredClone(gains);
    let rows = allocations;
    if (previous) {
        const paid = previous.sources.filter(id => (state.creditedSources ?? []).includes(id));
        assert(paid.length === 0 || paid.length === previous.sources.length, "partially adopted source batch");
        if (!paid.length) {
            assert(!previous.sources.includes(source), "duplicate generated distribution");
            sources.unshift(...previous.sources);
            rows = [...previous.allocations, ...allocations];
            for (const [account, tokens] of Object.entries(previous.gains)) {
                carried[account] ??= {};
                for (const [token, value] of Object.entries(tokens)) carried[account][token] = (BigInt(carried[account][token] ?? "0") + BigInt(value)).toString();
            }
        }
    }
    return { gains: carried, allocations: rows, sources };
}
