import { fetchIncentives } from "./1_incentives";
import * as dotenv from 'dotenv';
import { distribute } from "./2_distribution";
import { generateMerkle } from "./3_merkle";
import { check } from "./4_check";
import { patch } from "./5_patch";
import { buildBreakdown } from "./6_breakdown";

dotenv.config();

const main = async () => {
    // Patch overclaimed amounts (runs on previous merkle before new rewards)
    //await patch();

    // Fetch new incentives
    await fetchIncentives();

    // Distribute
    await distribute();

    // Generate merkle
    await generateMerkle();

    // Check claims
    await check();

    // Build breakdown (user → vault → token detail)
    await buildBreakdown();
};

main().catch(err => console.log(err));