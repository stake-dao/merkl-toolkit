import { getAddress } from 'viem';
import { getDistribution } from './utils/distribution';
import { getLastDistributionsData, overideDistributionData } from './utils/distributionData';
import { createCombineDistribution, generateMerkleTree, getMerkle, writeLastMerkle, writeMerkle } from './utils/merkle';
import { MerkleData } from './interfaces/MerkleData';

export const generateMerkle = async () => {
    console.log("🔄 Starting merkle generation...");

    const distributionsData = getLastDistributionsData();
    console.log(`📂 Found ${distributionsData.length} distributions`);

    const lastPendingDistributionsData = distributionsData.filter((dist) => dist.sentOnchain === false);
    if(lastPendingDistributionsData.length !== 1) {
        console.log("✅ No pending distribution found");
        return
    }

    const lastDistributionData = lastPendingDistributionsData[0];
    console.log(`📌 Using latest distribution with timestamp ${lastDistributionData.timestamp}`);

    let merkle: MerkleData = { merkleRoot: "", claims: {} };

    if (distributionsData.length > 1) {
        const previousDistributionData = distributionsData[distributionsData.length - 2];
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

    // tag the distribution as sent onchain
    lastDistributionData.sentOnchain = true;
    overideDistributionData(distributionsData)

    // Write the merkle again in the data root path
    writeLastMerkle(merkleData);
}