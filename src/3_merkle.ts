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
    writeLastMerkle,
    writeMerkle,
} from "./utils/merkle";
import { MerkleData } from "./interfaces/MerkleData";
import { safeStringify } from "./utils/parse";

export const generateMerkle = async () => {
    console.log("🔄 Starting merkle generation...");

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
        merkle = getMerkle(previousDistributionData.timestamp);
    }

    console.log("📝 Loading current distribution...");
    const currentDistribution = getDistribution(lastDistributionData.timestamp);
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
        merkle,
        debts
    );

    // Save updated debts
    if (debts) {
        const remainingDebtors = Object.keys(debts).length;
        if (remainingDebtors === 0) {
            fs.unlinkSync(debtsPath);
            console.log("✅ All debts fully repaid — removed debts.json");
        } else {
            fs.writeFileSync(debtsPath, safeStringify(debts), { encoding: "utf-8" });
            console.log(`💾 Updated debts.json — ${remainingDebtors} users still indebted`);
        }
    }

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

    console.log("💾 Saving merkle file...");
    writeMerkle(currentDistribution.timestamp, merkleData);
    console.log("✅ Merkle file saved");

    // tag the distribution as sent onchain
    lastDistributionData.sentOnchain = true;
    overideDistributionData(distributionsData);

    // Write the merkle again in the root path
    writeLastMerkle(merkleData);

    console.log("🏁 Merkle generation finished and distribution marked as sent");
};