import { fetchIncentives } from "./1_incentives";
import * as dotenv from 'dotenv';
import { distribute } from "./2_distribution";
import { verifyDistribution } from "./scripts/verify_distribution";
import { getLastDistributionsData } from "./utils/distributionData";
import { generateMerkle } from "./3_merkle";
import { check } from "./4_check";
import { patch } from "./5_patch";
import { buildBreakdown } from "./6_breakdown";
import { refreshCache } from "./7_refresh_cache";
import fs from "fs";
import path from "path";
import { readActiveBaseline } from "./utils/merkle";

dotenv.config();

const main = async () => {
    // Stop before advancing incentive cursors if an on-chain recovery has not
    // been adopted locally. No old root may restore expired entitlements.
    await readActiveBaseline(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../data/last_merkle.json"), "utf8")));

    // Patch overclaimed amounts (runs on previous merkle before new rewards)
    //await patch();

    // Fetch new incentives
    await fetchIncentives();

    // Distribute
    await distribute();

    // Verify the pending distribution independently before baking it into the merkle
    const pending = getLastDistributionsData().find((dist) => dist.sentOnchain === false);
    if (pending) {
        const { errors } = await verifyDistribution({ timestamp: Number(pending.timestamp) });
        if (errors.length > 0) {
            console.error(`🚨 Distribution verification failed (${errors.length} error(s)) — aborting before merkle generation`);
            process.exit(1);
        }
    }

    // Generate merkle
    await generateMerkle();

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
