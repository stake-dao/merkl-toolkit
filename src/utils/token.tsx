import axios from "axios";
import { Address } from "viem";
import * as dotenv from 'dotenv';
import { TokenHolder } from "../interfaces/TokenHolder";

dotenv.config();

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
if (!MORALIS_API_KEY) {
    throw new Error("MORALIS_API_KEY is not set in .env");
}

export const getTokenHolders = async (gaugeAddress: Address): Promise<TokenHolder[]> => {
    const holders: TokenHolder[] = [];

    let cursor: string | null = null;
    const limit = 100; // max value accepted by Moralis API

    do {
        const url: string = `https://deep-index.moralis.io/api/v2.2/erc20/${gaugeAddress}/owners?chain=eth&limit=${limit}&order=DESC${cursor ? `&cursor=${cursor}` : ''}`;

        const { data } = await axios.get(url, {
            headers: {
                'X-API-Key': MORALIS_API_KEY,
            }
        });

        console.log(`📦 Page ${data.page}, ${data.result.length} holders`);

        for (const holder of data.result) {
            holders.push({
                user: holder.owner_address as Address,
                balance: holder.balance,
            });
        }

        cursor = data.cursor || null;
    } while (cursor);

    console.log(`✅ Finished fetching. Total holders: ${holders.length}`);

    return holders;
};