import { getAddress } from 'viem';
import { getDistribution } from './utils/distribution';
import { getLastDistributionsData } from './utils/distributionData';
import { createCombineDistribution, generateMerkleTree, getMerkle, writeMerkle } from './utils/merkle';
import { MerkleData } from './interfaces/MerkleData';

export const generateMerkle = async () => {
    console.log("🔄 Starting merkle generation...");

    const lastDistributionsData = getLastDistributionsData();
    console.log(`📂 Found ${lastDistributionsData.length} distributions`);

    const lastDistributionData = lastDistributionsData[lastDistributionsData.length - 1];
    console.log(`📌 Using latest distribution with timestamp ${lastDistributionData.timestamp}`);

    let merkle: MerkleData = { merkleRoot: "", claims: {} };

    if (lastDistributionsData.length > 1) {
        const previousDistributionData = lastDistributionsData[lastDistributionsData.length - 2];
        console.log(`📖 Loading previous merkle (timestamp ${previousDistributionData.timestamp})...`);
        merkle = getMerkle(previousDistributionData.timestamp);
    }

    console.log("📝 Creating current distribution...");
    const currentDistribution = getDistribution(lastDistributionData.timestamp);
    console.log(`✅ Distribution loaded with ${currentDistribution.incentives.length} incentives`);

    console.log("➕ Combining distributions...");
    const distributionCombined = createCombineDistribution(currentDistribution, merkle);

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
    console.log(`✅ Normalized ${Object.keys(merkleData.claims).length} addresses`);

    console.log("💾 Saving merkle file...");
    writeMerkle(currentDistribution.timestamp, merkleData);
    console.log("✅ Merkle file saved");
}