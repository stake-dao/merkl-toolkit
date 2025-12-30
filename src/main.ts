import { fetchIncentives } from "./1_incentives";
import * as dotenv from 'dotenv';
import { distribute } from "./2_distribution";
import { generateMerkle } from "./3_merkle";
import { base } from "viem/chains";

dotenv.config();

const main = async () => {

    console.log('💰 - Running Mainnet distributions')
    // Fetch new incentives
    await fetchIncentives();

    // Distribute
    await distribute();

    // Generate merkle
    await generateMerkle();

    console.log('💰 - Running Base distributions')

    // Fetch new incentives
    await fetchIncentives(base.id);

    // Distribute
    await distribute(base.id);

    // Generate merkle
    await generateMerkle(base.id);
};

main().catch(err => console.log(err));
