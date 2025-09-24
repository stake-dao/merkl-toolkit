import { fetchIncentives } from "./1_incentives";
import { distribute } from "./2_distribution";
import * as dotenv from 'dotenv';

dotenv.config();

const main = async () => {
    // Fetch new incentives
    await fetchIncentives();

    // Distribute
    await distribute();
};

main().catch(err => console.log(err));