import { getAddress } from 'viem';
import { getDistribution } from './utils/distribution';
import { getLastDistributionsData } from './utils/distributionData';
import { createCombineDistribution, generateMerkleTree, getMerkle, writeMerkle } from './utils/merkle';
import { MerkleData } from './interfaces/MerkleData';

export const generateMerkle = async () => {
    const lastDistributionsData = getLastDistributionsData();

    // Load distribution file
    const lastDistributionData = lastDistributionsData[lastDistributionsData.length - 1];

    let merkle: MerkleData = { merkleRoot: "", claims: {} };

    if (lastDistributionsData.length > 1) {
        // Get the previous merkle
        const previousDistributionData = lastDistributionsData[lastDistributionsData.length - 2];

        // Get the merkle file
        merkle = getMerkle(previousDistributionData.timestamp);
    }

    // Create distribution
    const currentDistribution = getDistribution(lastDistributionData.timestamp);

    const distributionCombined = createCombineDistribution(currentDistribution, merkle)

    // Generate the merkle root
    const merkleData = generateMerkleTree(distributionCombined);

    // Checksum all addresses
    merkleData.claims = Object.fromEntries(
        Object.entries(merkleData.claims).map(([address, claim]) => [
            getAddress(address),
            claim,
        ])
    );

    writeMerkle(currentDistribution.timestamp, merkleData)
}