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

export const generateMerkle = async (chainId = 1) => {
    console.log("🔄 Starting merkle generation...");

    const distributionsData = getLastDistributionsData(chainId);
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
        merkle = getMerkle(previousDistributionData.timestamp, chainId);
    }

    console.log("📝 Loading current distribution...");
    const currentDistribution = getDistribution(lastDistributionData.timestamp, chainId);
    console.log(
        `✅ Distribution loaded with ${currentDistribution.incentives.length} incentives`
    );

    console.log("➕ Combining distributions...");
    const distributionCombined = createCombineDistribution(
        currentDistribution,
        merkle
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

    console.log("💾 Saving merkle file...");
    writeMerkle(currentDistribution.timestamp, merkleData, chainId);
    console.log("✅ Merkle file saved");

    // tag the distribution as sent onchain
    lastDistributionData.sentOnchain = true;
    overideDistributionData(distributionsData, chainId);

    // Write the merkle again in the root path
    writeLastMerkle(merkleData, chainId);

    console.log("🏁 Merkle generation finished and distribution marked as sent");
};