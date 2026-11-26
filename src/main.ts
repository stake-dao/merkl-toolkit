import { fetchIncentives } from "./1_incentives";
import * as dotenv from 'dotenv';
import { distribute } from "./2_distribution";
import { generateMerkle } from "./3_merkle";
import { check } from "./4_check";
import { buildBreakdown } from "./6_breakdown";
import { refreshCache } from "./7_refresh_cache";
import path from "path";
import fs from "fs";
import { prepareFirmRecovery } from "./recovery/firm_round";
import { applyPmusdRecovery } from "./recovery/pmusd";
import { readActiveBaseline } from "./utils/merkle";
import { getLastDistributionsData } from "./utils/distributionData";
import { getClient } from "./utils/rpc";
import { writeIncentives } from "./utils/incentives";

dotenv.config();

const main = async () => {
    // Stop before advancing incentive cursors if an on-chain recovery has not
    // been adopted locally. No old root may restore expired entitlements.
    const dataDir = path.resolve(__dirname, "../data");
    const active = await readActiveBaseline(JSON.parse(fs.readFileSync(path.join(dataDir, "last_merkle.json"), "utf8")));
    const client = await getClient(1);
    const recovery = await prepareFirmRecovery(dataDir, active, client);
    const updatedIncentives = await fetchIncentives();
    const pending = getLastDistributionsData().some(round => !round.sentOnchain);
    const distributed = !pending && await distribute(updatedIncentives);
    // A completed distribution saves its own incentive cursors.
    if (updatedIncentives && !distributed) writeIncentives(updatedIncentives);
    await applyPmusdRecovery(dataDir, () => client.getBlock({ blockTag: "latest" }));
    await generateMerkle(active.merkleRoot, recovery);

    // Check claims
    await check();

    // Build breakdown (user → vault → token detail)
    await buildBreakdown();

    // Refresh caches via Cloudflare worker
    await refreshCache();
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
