import { existsSync } from "node:fs";
import path from "node:path";
import { erc20Abi, getAddress, type PublicClient } from "viem";
import allocations from "../../config/pmusd-twab-recovery.json";
import { merklAbi } from "../abis/Merkl";
import { MERKL_CONTRACT } from "../constants";
import type { Distribution, IncentiveDistribution } from "../interfaces/Distribution";
import type { DistributionData } from "../interfaces/DistributionData";
import type { MerkleData } from "../interfaces/MerkleData";
import { isTrustedIncentive } from "../utils/merkl";
import { openEmptyRound, read, write } from "./round";

const token = { address: getAddress("0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf"), symbol: "pmUSD", decimals: 18 };

const refund = 353239532329539949908n;
const anchor = {
    timestamp: 1795672871, blockNumber: 26497442,
    merkleRoot: "0x076a2ce306b71f0a9623397170baa9101a42cacc16d3a2ed3ebf6418f1692b31",
    incentiveCount: 2610n, pmusdFunding: 71679499055389355574629n,
};

const isRecovery = (row: IncentiveDistribution) => row.distribution.recovery === "pmusd-twab";

/** Windows move campaign funding into claimable leaves; only claims release that reserve. */
export async function readPmusdSurplus(
    baseline: MerkleData, client: Pick<PublicClient, "readContract" | "multicall">, blockNumber: bigint,
) {
    const atBlock = { blockNumber, authorizationList: undefined };
    const distributor = { address: MERKL_CONTRACT, abi: merklAbi };
    const holders = new Set(Object.entries(baseline.claims)
        .filter(([, claim]) => Object.keys(claim.tokens).some(address => getAddress(address) === token.address))
        .map(([user]) => getAddress(user)));
    const [root, count, balance, claimed] = await Promise.all([
        client.readContract({ ...atBlock, ...distributor, functionName: "root" }),
        client.readContract({ ...atBlock, ...distributor, functionName: "nbIncentives" }),
        client.readContract({ ...atBlock, address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [MERKL_CONTRACT] }),
        client.multicall({ ...atBlock, allowFailure: false, contracts: [...holders].map(user => ({
            ...distributor, functionName: "claimed" as const, args: [user, token.address] as const,
        })) }),
    ]);
    if (root !== baseline.merkleRoot || count < anchor.incentiveCount) throw new Error("pmUSD funding snapshot differs from production history");

    const ids: bigint[] = [];
    for (let id = anchor.incentiveCount; id < count; id++) ids.push(id);
    const campaigns = ids.length === 0 ? [] : await client.multicall({ ...atBlock, allowFailure: false, contracts: ids.map(id => ({
        ...distributor, functionName: "incentives" as const, args: [id] as const,
    })) });
    let funded = anchor.pmusdFunding;
    for (const [, reward, , , , chain, sender, amount] of campaigns) {
        if (getAddress(reward) === token.address && isTrustedIncentive(chain, sender)) funded += amount;
    }
    return balance - funded + claimed.reduce((sum, amount) => sum + amount, 0n);
}

/** Reimburse the March TWAB windows once, on the production history that contains them (ENG-2316). */
export async function applyPmusdRecovery(
    dir: string, getBlock: () => Promise<{ number: bigint; timestamp: bigint }>,
    getSurplus: (blockNumber: bigint) => Promise<bigint>,
) {
    const indexFile = path.join(dir, "distribution.json");
    if (!existsSync(indexFile)) return;
    const index = read<DistributionData[]>(indexFile);
    const from = index.findIndex(round => round.timestamp === anchor.timestamp && round.sentOnchain);
    if (from === -1) return;
    const roundFile = (round: DistributionData, name = "distribution.json") =>
        path.join(dir, "distributions", String(round.timestamp), name);
    for (const round of index.slice(from + 1)) {
        if (round.sentOnchain && read<Distribution>(roundFile(round)).incentives.some(isRecovery)) return;
    }
    const witness = read<Pick<MerkleData, "merkleRoot">>(roundFile(index[from], "merkle.json"));
    if (index[from].blockNumber !== anchor.blockNumber || witness.merkleRoot !== anchor.merkleRoot) {
        throw new Error("pmUSD recovery anchor differs from production history");
    }
    if (index.slice(0, -1).some(round => !round.sentOnchain)) throw new Error("Expected at most one pending final round");
    const last = index[index.length - 1];
    const pending = last.sentOnchain ? undefined : read<Distribution>(roundFile(last));
    if (pending && (pending.timestamp !== last.timestamp || pending.blockNumber !== last.blockNumber)) {
        throw new Error("Pending pmUSD distribution differs from its index");
    }
    const credited = pending?.incentives.some(isRecovery);
    const block = await getBlock();
    const surplus = await getSurplus(block.number);
    if (surplus < refund) {
        if (credited) throw new Error("pmUSD refund missing for the credited pending round");
        console.warn(`pmUSD recovery postponed: distributor surplus ${surplus} < refund ${refund}`);
        return;
    }
    if (credited) return;
    const credits = allocations.map(({ vault, incentiveId, allocations: amounts }): IncentiveDistribution => {
        const users = Object.entries(amounts).map(([user, amount]) => ({
            user: getAddress(user), amount, balance: "0", share: "0.000000", source: "direct" as const,
        }));
        const amountToDistribute = users.reduce((sum, user) => sum + BigInt(user.amount), 0n);
        return {
            vault: getAddress(vault), token, users,
            distribution: { incentiveId, amountToDistribute, incentivePerSecond: 0n, recovery: "pmusd-twab" },
        };
    });
    if (credits.reduce((sum, row) => sum + row.distribution.amountToDistribute, 0n) !== refund) {
        throw new Error("pmUSD recovery allocations do not match the reimbursed amount");
    }

    const round = pending ? last : openEmptyRound(dir, index, block);
    const distribution = pending ?? { timestamp: round.timestamp, blockNumber: round.blockNumber, incentives: [] };
    distribution.incentives.push(...credits);
    write(roundFile(round), distribution);
}
