import { fetchIncentives } from "./1_incentives";
import * as dotenv from 'dotenv';
import { distribute } from "./2_distribution";
import { generateMerkle } from "./3_merkle";
import { check } from "./4_check";
import { buildBreakdown } from "./6_breakdown";
import { refreshCache } from "./7_refresh_cache";
import path from "path";
import { prepareFirmRecovery } from "./recovery/firm_round";
import { readPipelineBaseline } from "./recovery/firm_baseline";
import { getClient } from "./utils/rpc";

dotenv.config();

const main = async () => {
    // Stop before advancing incentive cursors if an on-chain recovery has not
    // been adopted locally. No old root may restore expired entitlements.
    const dataDir = path.resolve(__dirname, "../data");
    const client = await getClient(1);
    const active = await readPipelineBaseline(dataDir, client);
    if (!await prepareFirmRecovery(dataDir, active, client)) {
        await fetchIncentives();
        await distribute();
        await generateMerkle();
    }

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
