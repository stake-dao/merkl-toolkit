import { fetchIncentives } from "./1_incentives";
import * as dotenv from 'dotenv';
import { distribute } from "./2_distribution";
import { generateMerkle } from "./3_merkle";

dotenv.config();

const main = async () => {
    // Fetch new incentives
    await fetchIncentives();

    // Distribute
    await distribute();

    // Generate merkle
    await generateMerkle();
};

main().catch(err => console.log(err));