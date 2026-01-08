import { fetchIncentives } from "./1_incentives";
import * as dotenv from 'dotenv';
import { distribute } from "./2_distribution";
import { generateMerkle } from "./3_merkle";
import { check } from "./4_check";

dotenv.config();

const main = async () => {
    // Fetch new incentives
    await fetchIncentives();

    // Distribute
    await distribute();

    // Generate merkle
    await generateMerkle();

    // Check claims
    await check();
};

main().catch(err => console.log(err));
