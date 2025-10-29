import { fetchIncentives } from "@src/1_incentives";
import * as dotenv from 'dotenv';
import { distribute } from "@src/2_distribution";
import { generateMerkle } from "@src/3_merkle";

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
