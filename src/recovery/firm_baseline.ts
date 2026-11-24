import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PublicClient } from "viem";
import type { Distribution } from "../interfaces/Distribution";
import type { DistributionData } from "../interfaces/DistributionData";
import type { MerkleData } from "../interfaces/MerkleData";
import { readActiveRoot, rebuildMerkleClaims, resolveRecoveryBaseline } from "../utils/merkle";
import { buildFirmRecoveryTrees, FIRM_RECOVERY } from "./firm";

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8"));

/** Use the active baseline, including when a verified FiRM round is still awaiting publication. */
export async function readPipelineBaseline(
    dir: string, client: Pick<PublicClient, "getChainId" | "readContract">,
): Promise<MerkleData> {
    const activeRoot = await readActiveRoot(client);
    const local = read<MerkleData>(path.join(dir, "last_merkle.json"));
    const recoveries = path.join(dir, "recoveries");
    const rounds = path.join(dir, "distributions");
    const snapshot = (timestamp: number) => read<MerkleData>(path.join(rounds, String(timestamp), "merkle.json"));
    let last: DistributionData;
    let previous: DistributionData;
    let sourceRound: DistributionData;
    try {
        return resolveRecoveryBaseline(local, activeRoot, recoveries);
    } catch (error) {
        if (local.merkleRoot === activeRoot) throw error;
        const index = read<DistributionData[]>(path.join(dir, "distribution.json"));
        last = index[index.length - 1];
        previous = index[index.length - 2];
        if (!last?.firmRecovery || !previous) throw error;
        sourceRound = last.firmRecovery.stage === "withdraw" ? previous : index[index.length - 3];
    }

    const { stage, sourceTimestamp, sourceRoot } = last.firmRecovery;
    if (!["withdraw", "credit", "restore"].includes(stage) || !sourceRound?.sentOnchain ||
        !Number.isSafeInteger(sourceTimestamp) || sourceRound.timestamp !== sourceTimestamp ||
        !last.sentOnchain || previous.timestamp >= last.timestamp) {
        throw new Error("Invalid FiRM recovery round sequence");
    }
    if (stage !== "withdraw" && (!previous.sentOnchain || previous.firmRecovery?.stage !== "withdraw" ||
        previous.firmRecovery.sourceRoot !== sourceRoot || previous.firmRecovery.sourceTimestamp !== sourceTimestamp ||
        sourceTimestamp >= previous.timestamp)) {
        throw new Error("FiRM recovery must follow its matching withdrawal round");
    }

    const source = resolveRecoveryBaseline(snapshot(sourceTimestamp), sourceRoot, recoveries);
    if (!isDeepStrictEqual(source, rebuildMerkleClaims(source))) throw new Error("Invalid FiRM source proofs");
    const history = read<Distribution>(path.join(rounds, String(FIRM_RECOVERY.timestamp), "distribution.json"));
    // These are the deterministic candidate trees. The fresh on-chain claimed check
    // before preparing a withdrawal/credit/restore remains in prepareFirmRecovery.
    const { withdrawn, credited } = buildFirmRecoveryTrees(source, history, 0n);
    const parent = stage === "withdraw" ? source : withdrawn;
    if (activeRoot !== parent.merkleRoot || (stage !== "withdraw" && !isDeepStrictEqual(snapshot(previous.timestamp), parent))) {
        throw new Error("Active root or withdrawal snapshot differs from the expected FiRM recovery parent");
    }
    const candidate = stage === "withdraw" ? withdrawn : stage === "credit" ? credited : source;
    if (!isDeepStrictEqual(local, candidate) || !isDeepStrictEqual(snapshot(last.timestamp), candidate)) {
        throw new Error("Local FiRM recovery candidate differs from the expected tree");
    }
    return parent;
}
