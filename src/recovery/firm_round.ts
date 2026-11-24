import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PublicClient } from "viem";
import { MERKL_CONTRACT } from "../constants";
import { merklAbi } from "../abis/Merkl";
import type { Distribution } from "../interfaces/Distribution";
import type { DistributionData } from "../interfaces/DistributionData";
import type { MerkleData } from "../interfaces/MerkleData";
import type { SerializedEarnedEntry } from "../interfaces/Breakdown";
import { resolveRecoveryBaseline } from "../utils/merkle";
import { safeStringify } from "../utils/parse";
import { buildFirmRecoveryTrees, buildFirmWithdrawal, FIRM_RECOVERY, repairFirmDistribution, repairFirmEarned } from "./firm";

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

/**
 * Each correction round produces an ordinary timestamped Merkle for the existing
 * publisher. Its empty incentive list leaves TWAB cursors and debts untouched.
 * The original published snapshot remains available for audit and deterministic retries.
 */
export async function prepareFirmRecovery(
    dir: string, active: MerkleData, client: Pick<PublicClient, "getBlock" | "readContract">,
): Promise<boolean> {
    const roundDir = (timestamp: number) => path.join(dir, "distributions", String(timestamp));
    const indexFile = path.join(dir, "distribution.json");
    const index = fs.existsSync(indexFile) ? read<DistributionData[]>(indexFile) : [];
    const last = index[index.length - 1];
    if (!index.some(round => round.timestamp === FIRM_RECOVERY.timestamp)) {
        if (last?.firmRecovery || (last?.timestamp >= FIRM_RECOVERY.timestamp &&
            active.claims[FIRM_RECOVERY.escrow]?.tokens[FIRM_RECOVERY.token])) {
            throw new Error("Missing historical distribution for the FiRM escrow entitlement");
        }
        return false;
    }
    const historicalFile = path.join(roundDir(FIRM_RECOVERY.timestamp), "distribution.json");
    const history = read<Distribution>(historicalFile);
    const repaired = repairFirmDistribution(history);
    const progress = last?.firmRecovery;
    if (repaired === history && (!progress || (progress.stage === "credit" &&
        read<MerkleData>(path.join(roundDir(last.timestamp), "merkle.json")).merkleRoot === active.merkleRoot))) {
        return false;
    }
    if (!last || index.some(round => !round.sentOnchain)) {
        throw new Error("Finish the pending distribution before the FiRM recovery");
    }

    const sourceTimestamp = progress?.sourceTimestamp ?? last.timestamp;
    const sourceRoot = progress?.sourceRoot ?? active.merkleRoot;
    const source = resolveRecoveryBaseline(read<MerkleData>(path.join(roundDir(sourceTimestamp), "merkle.json")),
        sourceRoot, path.join(dir, "recoveries"));
    const block = await client.getBlock({ blockTag: "finalized" });
    const distributor = { address: MERKL_CONTRACT, abi: merklAbi, blockNumber: block.number, authorizationList: undefined };
    const [confirmedRoot, claimed] = await Promise.all([
        client.readContract({ ...distributor, functionName: "root" }),
        client.readContract({ ...distributor, functionName: "claimed", args: [FIRM_RECOVERY.escrow, FIRM_RECOVERY.token] }),
    ]);
    if (confirmedRoot !== active.merkleRoot) throw new Error("Wait for the active FiRM recovery baseline to finalize");
    const paid = claimed === FIRM_RECOVERY.amount;
    if (paid && confirmedRoot === sourceRoot && (!progress || progress.stage === "restore")) {
        if (BigInt(source.claims[FIRM_RECOVERY.escrow]?.tokens[FIRM_RECOVERY.token]?.amount ?? 0) !== claimed) {
            throw new Error("Claimed FiRM DOLA differs from the source entitlement");
        }
        console.warn("FiRM incentive #2601 was paid under its original proof");
        return false;
    }

    // An intervening payment makes the fully paid source tree the final state.
    // In either case the only permissible intermediate root drops just the escrow leaf.
    const { withdrawn, credited } = paid
        ? { withdrawn: buildFirmWithdrawal(source, history), credited: source }
        : buildFirmRecoveryTrees(source, history, claimed);
    let stage: NonNullable<DistributionData["firmRecovery"]>["stage"];
    let tree: MerkleData;
    if (confirmedRoot === sourceRoot && (!progress || progress.stage === "withdraw")) {
        stage = "withdraw";
        tree = withdrawn;
    } else if (confirmedRoot === withdrawn.merkleRoot && progress) {
        stage = paid ? "restore" : "credit";
        if (progress.stage !== "withdraw" && progress.stage !== stage) throw new Error("Unexpected FiRM recovery stage");
        tree = credited;
    } else throw new Error("Unexpected active root for the FiRM historical recovery");

    const retry = progress?.stage === stage;
    const timestamp = retry ? last.timestamp : Number(block.timestamp);
    const blockNumber = retry ? last.blockNumber : Number(block.number);
    if (!retry && timestamp <= last.timestamp) throw new Error("Wait for a newer finalized distribution block");
    const folder = roundDir(timestamp);
    const snapshotFile = path.join(folder, "merkle.json");
    if (fs.existsSync(snapshotFile) && read<MerkleData>(snapshotFile).merkleRoot !== tree.merkleRoot) {
        throw new Error("Conflicting Merkle at the FiRM recovery timestamp");
    }

    // Check the existing earned cache before staging any changes. A full rebuild
    // reads the corrected historical distribution and arrives at the same result.
    const earnedFile = path.join(dir, "breakdown", "earned.json");
    const metaFile = path.join(dir, "breakdown", "meta.json");
    const lastProcessed = fs.existsSync(metaFile) ? read<{ lastProcessedTimestamp: number }>(metaFile).lastProcessedTimestamp : 0;
    const updateCache = stage === "credit" && lastProcessed >= history.timestamp;
    const earnings = updateCache ? repairFirmEarned(read<Record<string, SerializedEarnedEntry[]>>(earnedFile), lastProcessed) : undefined;

    fs.mkdirSync(folder, { recursive: true });
    write(snapshotFile, tree);
    write(path.join(folder, "distribution.json"), { timestamp, blockNumber, incentives: [] });
    if (!retry) write(indexFile, [...index, { blockNumber, timestamp, sentOnchain: true,
        firmRecovery: { stage, sourceTimestamp, sourceRoot } }]);
    if (stage === "credit") {
        if (earnings) write(earnedFile, earnings);
        write(historicalFile, repaired);
    }
    // Commit the candidate last so an interrupted preparation can replay the indexed round.
    write(path.join(dir, "last_merkle.json"), tree);
    console.log(`FiRM incentive #2601: prepared ${stage} root ${tree.merkleRoot}`);
    return true;
}
