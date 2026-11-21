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
import { carryUnpublished, prepareMonthlyPublication, readMonthlyJournal } from "./utils/monthlyExpiry";

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
        merkle = await readActiveBaseline(getMerkle(previousDistributionData.timestamp));
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
    const journal = await readMonthlyJournal();
    const distributionCombined = createCombineDistribution(
        currentDistribution,
        journal ? { merkleRoot: "", claims: {} } : merkle,
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
    const publicationPath = path.resolve(__dirname, "../data/last_publication.json");
    const previous = fs.existsSync(publicationPath) ? JSON.parse(fs.readFileSync(publicationPath, "utf8")) : undefined;
    const batch = journal ? carryUnpublished(journal, distributionCombined, currentDistribution.incentives, `extra:${currentDistribution.timestamp}`, previous) : undefined;
    const publication = journal && batch ? await prepareMonthlyPublication(journal, batch.gains, batch.allocations, batch.sources) : undefined;
    const merkleData = publication?.merkle ?? generateMerkleTree(distributionCombined);
    if (publication) fs.writeFileSync(publicationPath, safeStringify(publication));
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
