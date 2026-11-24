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
import { readActiveBaseline } from "./utils/merkle";
import { getLastDistributionsData } from "./utils/distributionData";
import { getClient } from "./utils/rpc";

dotenv.config();

const main = async () => {
    // Stop before advancing incentive cursors if an on-chain recovery has not
    // been adopted locally. No old root may restore expired entitlements.
    const dataDir = path.resolve(__dirname, "../data");
    const active = await readActiveBaseline(JSON.parse(fs.readFileSync(path.join(dataDir, "last_merkle.json"), "utf8")));
    const recovery = await prepareFirmRecovery(dataDir, active, await getClient(1));
    await fetchIncentives();
    if (!getLastDistributionsData().some(round => !round.sentOnchain)) {
        await distribute();
    }
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
