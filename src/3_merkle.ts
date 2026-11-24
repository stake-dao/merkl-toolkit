import fs from "fs";
import path from "path";
import { getAddress } from "viem";
import { getDistribution } from "./utils/distribution";
import {
    getLastDistributionsData,
    overideDistributionData,
} from "./utils/distributionData";
import {
    createCombineDistribution,
    generateMerkleTree,
    getMerkle,
    readActiveBaseline,
    writeLastMerkle,
    writeMerkle,
} from "./utils/merkle";
import { MerkleData } from "./interfaces/MerkleData";
import { safeStringify } from "./utils/parse";
import type { PreparedFirmRecovery } from "./recovery/firm_round";

export const generateMerkle = async (expectedParentRoot?: string, recovery?: PreparedFirmRecovery) => {
    console.log("🔄 Starting merkle generation...");

    recovery?.ensurePendingRound();
    const distributionsData = getLastDistributionsData();
    console.log(`📂 Found ${distributionsData.length} distributions`);

    // find the first unsent distribution (should only be one)
    const lastDistributionData = distributionsData.find(
        (dist) => dist.sentOnchain === false
    );

    if (!lastDistributionData) {
        console.log("✅ No pending distribution found");
        return;
    }
    if (lastDistributionData !== distributionsData[distributionsData.length - 1]) {
        throw new Error("Pending Merkle distribution must be the last indexed round");
    }

    console.log(
        `📌 Using pending distribution with timestamp ${lastDistributionData.timestamp}`
    );

    let merkle: MerkleData = { merkleRoot: "", claims: {} };

    // If there is a previous distribution, load its merkle
    if (distributionsData.length > 1) {
        const previousDistributionData =
            distributionsData[distributionsData.length - 2];
        console.log(
            `📖 Loading previous merkle (timestamp ${previousDistributionData.timestamp})...`
        );
        if (recovery && (lastDistributionData.timestamp <= previousDistributionData.timestamp ||
            lastDistributionData.blockNumber <= previousDistributionData.blockNumber)) {
            throw new Error("Pending Merkle distribution must follow its parent block and timestamp");
        }
        merkle = await readActiveBaseline(getMerkle(previousDistributionData.timestamp));
    }
    if (distributionsData.length > 1 && expectedParentRoot !== undefined && expectedParentRoot !== merkle.merkleRoot) {
        throw new Error("Active distribution parent changed since preflight");
    }
    if (recovery && recovery.sourceRoot !== merkle.merkleRoot) throw new Error("FiRM recovery parent mismatch");

    console.log("📝 Loading current distribution...");
    const currentDistribution = getDistribution(lastDistributionData.timestamp);
    if (recovery && (currentDistribution.timestamp !== lastDistributionData.timestamp || currentDistribution.blockNumber !== lastDistributionData.blockNumber)) {
        throw new Error("Pending distribution block or timestamp differs from its index");
    }
    console.log(
        `✅ Distribution loaded with ${currentDistribution.incentives.length} incentives`
    );

    // Load debts if they exist
    const debtsPath = path.resolve(__dirname, "../data/debts.json");
    let debts: Record<string, Record<string, string>> | undefined;
    if (fs.existsSync(debtsPath)) {
        debts = JSON.parse(fs.readFileSync(debtsPath, { encoding: "utf-8" }));
        const debtorCount = Object.keys(debts!).length;
        console.log(`📋 Loaded debts for ${debtorCount} users`);
    }

    console.log("➕ Combining distributions...");
    const distributionCombined = createCombineDistribution(
        currentDistribution,
        recovery?.baseline ?? merkle,
        debts
    );

    console.log("🌳 Generating merkle tree...");
    const merkleData = generateMerkleTree(distributionCombined);
    console.log(`✅ Merkle root generated: ${merkleData.merkleRoot}`);

    console.log("🔑 Normalizing addresses...");
    merkleData.claims = Object.fromEntries(
        Object.entries(merkleData.claims).map(([address, claim]) => [
            getAddress(address),
            claim,
        ])
    );
    console.log(
        `✅ Normalized ${Object.keys(merkleData.claims).length} addresses`
    );

    await recovery?.confirmUnclaimed();
    console.log("💾 Saving merkle file...");
    writeMerkle(currentDistribution.timestamp, merkleData);
    console.log("✅ Merkle file saved");

    if (debts) {
        if (Object.keys(debts).length === 0) fs.unlinkSync(debtsPath);
        else fs.writeFileSync(debtsPath, safeStringify(debts), { encoding: "utf-8" });
    }

    if (recovery) {
        recovery.repairHistory();
        lastDistributionData.firmRecovery = { sourceRoot: recovery.sourceRoot };
    }
    // tag the distribution as sent onchain
    lastDistributionData.sentOnchain = true;
    overideDistributionData(distributionsData);

    // Write the merkle again in the root path
    writeLastMerkle(merkleData);

    console.log("🏁 Merkle generation finished and distribution marked as sent");
};
