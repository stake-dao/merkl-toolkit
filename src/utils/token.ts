import axios from "axios";
import { Address } from "viem";
import * as dotenv from "dotenv";
import { getHolders, HolderData, writeHolders } from "./holders";
import { TokenHolderScanner } from "./tokenHolderScanner";
import { base, mainnet } from "viem/chains";

dotenv.config();

const startBlocksForChain = {
    [mainnet.id] : 22_575_062,
    [base.id] : 33_248_274
}

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

async function fetchWithRetry<T>(url: string, retries = 5, delay = 2000): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const { data } = await axios.get<T>(url, {
                headers: {
                    "X-API-Key": MORALIS_API_KEY,
                },
            });
            return data;
        } catch (err) {
            console.error(`❌ Moralis : Attempt ${attempt} failed for ${url}`);
            if (attempt === retries) throw err;
            console.log(`⏳ Moralis : Retrying in ${delay / 1000}s...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw new Error("Unreachable code: fetchWithRetry loop ended");
}

/*export const getTokenHolders = async (gaugeAddress: Address): Promise<TokenHolder[]> => {
    const holders: TokenHolder[] = [];
    let cursor: string | null = null;
    const limit = 100; // max value accepted by Moralis API

    do {
        const url = `https://deep-index.moralis.io/api/v2.2/erc20/${gaugeAddress}/owners?chain=eth&limit=${limit}&order=DESC${cursor ? `&cursor=${cursor}` : ""}`;

        const data = await fetchWithRetry<any>(url);

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
};*/

interface HolderDataExtended extends HolderData {
    fromBlock: number;
}

export const getTokenHolders = async (vault: Address, toBlock: number, chainId: number): Promise<HolderDataExtended> => {

    const holdersData = getHolders(vault, chainId);
    const fromBlock = holdersData.blockNumber > 0 ? holdersData.blockNumber : startBlocksForChain[chainId];

    const scanner = new TokenHolderScanner(process.env.MAINNET_RPC_URL, vault, chainId);
    const newHolders = await scanner.getHoldersViaEtherscan(process.env.ETHERSCAN_API_KEY, vault, BigInt(fromBlock), BigInt(toBlock));

    let users = Array.from(new Set([...holdersData.users, ...newHolders]));
    users = users.filter((user) => user.toLowerCase() !== "0x0000000000000000000000000000000000000000".toLowerCase());

    writeHolders(vault, {
        blockNumber: toBlock,
        users
    }, chainId);

    return {
        blockNumber: toBlock,
        fromBlock,
        users: users
    };
};
