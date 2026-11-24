import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PublicClient } from "viem";
import { merklAbi } from "../abis/Merkl";
import { MERKL_CONTRACT } from "../constants";
import type { SerializedEarnedEntry } from "../interfaces/Breakdown";
import type { Distribution } from "../interfaces/Distribution";
import type { DistributionData } from "../interfaces/DistributionData";
import type { MerkleData } from "../interfaces/MerkleData";
import { safeStringify } from "../utils/parse";
import { FIRM_RECOVERY, reassignFirmBalance, repairFirmDistribution, repairFirmEarned } from "./firm";

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8"));

function write(file: string, value: unknown) {
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
        fs.writeFileSync(temporary, safeStringify(value));
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

export interface PreparedFirmRecovery {
    sourceRoot: string;
    baseline: MerkleData;
    ensurePendingRound(): void;
    confirmUnclaimed(): Promise<void>;
    repairHistory(): void;
}

/** Prepare a corrected parent in memory. The next ordinary round publishes it with that window's rewards. */
export async function prepareFirmRecovery(
    dir: string, active: MerkleData, client: Pick<PublicClient, "getBlock" | "readContract">,
): Promise<PreparedFirmRecovery | undefined> {
    if (active.merkleRoot !== FIRM_RECOVERY.parentRoot) return;

    async function readClaim() {
        const block = await client.getBlock({ blockTag: "latest" });
        const distributor = { address: MERKL_CONTRACT, abi: merklAbi, blockNumber: block.number, authorizationList: undefined };
        const [root, claimed] = await Promise.all([
            client.readContract({ ...distributor, functionName: "root" }),
            client.readContract({ ...distributor, functionName: "claimed", args: [FIRM_RECOVERY.escrow, FIRM_RECOVERY.token] }),
        ]);
        if (root !== active.merkleRoot) throw new Error("Active root changed during FiRM recovery");
        return { claimed, block };
    }

    const { claimed, block } = await readClaim();
    if (claimed === FIRM_RECOVERY.amount) {
        console.warn("FiRM incentive #2601 was already paid to its original account");
        return;
    }

    const indexFile = path.join(dir, "distribution.json");
    const roundDir = (timestamp: number) => path.join(dir, "distributions", String(timestamp));
    const historyFile = path.join(roundDir(FIRM_RECOVERY.timestamp), "distribution.json");
    const history = read<Distribution>(historyFile);
    const baseline = reassignFirmBalance(active, history, claimed);
    const repaired = repairFirmDistribution(history);

    const metaFile = path.join(dir, "breakdown", "meta.json");
    const earnedFile = path.join(dir, "breakdown", "earned.json");
    const lastProcessed = fs.existsSync(metaFile) ? read<{ lastProcessedTimestamp: number }>(metaFile).lastProcessedTimestamp : 0;
    const earned = lastProcessed >= history.timestamp ? read<Record<string, SerializedEarnedEntry[]>>(earnedFile) : undefined;
    const repairedEarned = earned && repairFirmEarned(earned, lastProcessed);

    return {
        sourceRoot: active.merkleRoot,
        baseline,
        ensurePendingRound() {
            const index = read<DistributionData[]>(indexFile);
            if (!index.some(round => round.timestamp === history.timestamp && round.blockNumber === history.blockNumber && round.sentOnchain)) {
                throw new Error("FiRM recovery historical distribution is missing from the index");
            }
            const last = index[index.length - 1];
            if (!last.sentOnchain) return;
            const timestamp = Number(block.timestamp);
            const blockNumber = Number(block.number);
            if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(blockNumber) ||
                timestamp <= last.timestamp || blockNumber <= last.blockNumber) {
                throw new Error("FiRM recovery requires a newer block for its empty distribution");
            }

            // Only needed if distribute() produced no window. Reuse an interrupted
            // empty round and never overwrite a real distribution at that timestamp.
            const folder = roundDir(timestamp);
            const distributionFile = path.join(folder, "distribution.json");
            if (fs.existsSync(distributionFile)) {
                const existing = read<Distribution>(distributionFile);
                if (existing.timestamp !== timestamp || existing.blockNumber !== blockNumber || existing.incentives.length !== 0) {
                    throw new Error("Conflicting distribution at the FiRM recovery timestamp");
                }
            } else {
                fs.mkdirSync(folder, { recursive: true });
                write(distributionFile, { blockNumber, timestamp, incentives: [] });
            }
            write(indexFile, [...index, { timestamp, blockNumber, sentOnchain: false }]);
        },
        async confirmUnclaimed() {
            if ((await readClaim()).claimed !== 0n) throw new Error("FiRM escrow DOLA claimed before Merkle export");
        },
        repairHistory() {
            if (earned && repairedEarned !== earned) write(earnedFile, repairedEarned);
            if (repaired !== history) write(historyFile, repaired);
        },
    };
}
