import { mainnet } from "viem/chains";
import { merklAbi } from "../abis/Merkl";
import { MERKL_CONTRACT } from "../constants";
import { getClient } from "./rpc";
import { IncentiveExtended } from "../interfaces/IncentiveExtended";
import { Incentive } from "../interfaces/Incentive";
import { Address, erc20Abi } from "viem";
import axios from "axios";
import { Strategy } from "../interfaces/Strategy";

const url = "https://raw.githubusercontent.com/stake-dao/api/main"
const PROTOCOLS = ["pendle", "balancer", "angle", "curve", "pancakeswap", "yearn", "passive", "v2/curve"];
const V2_CURVE_CHAIN_IDS = [1, 10, 100, 146, 252, 42161, 8453]

const getAllStakeDaoStrategies = async (): Promise<Strategy[]> => {
    const datas = await Promise.all(PROTOCOLS.map((protocol) => {
        if (protocol !== "v2/curve") {
            return [axios.get(`${url}/api/strategies/${protocol}/index.json`)]
        }

        return V2_CURVE_CHAIN_IDS.map((chainId) => axios.get(`${url}/api/strategies/${protocol}/${chainId}.json`))
    }).flat());

    return datas.map((data) => data.data?.deployed || data.data).flat() as Strategy[];
};

export const getMerklLastId = async (): Promise<number> => {
    const client = await getClient(1, true);

    return Number(await client.readContract({
        address: MERKL_CONTRACT,
        abi: merklAbi,
        functionName: "nbIncentives",
        args: [],
    }));
};

export const getNewIncentives = async (fromId: number, toId: number): Promise<IncentiveExtended[]> => {

    const strategies = await getAllStakeDaoStrategies();

    const client = await getClient(mainnet.id, true);
    const incentives: IncentiveExtended[] = [];

    for (let i = fromId; i < toId; i++) {
        const incentive = (await client.readContract({
            address: MERKL_CONTRACT,
            abi: merklAbi,
            functionName: "incentives",
            args: [BigInt(i)],
        })) as Incentive;

        // Check if we have a gauge deployed
        const strategy = strategies.find((strategy) => strategy.gaugeAddress.toLowerCase() === incentive.gauge.toLowerCase());
        if (!strategy) {
            continue;
        }

        incentive.id = i;

        // Fetch token data
        const [decimals, symbol] = await Promise.all([
            client.readContract({
                address: incentive.reward as Address,
                abi: erc20Abi,
                functionName: "decimals",
                args: [],
            }),
            client.readContract({
                address: incentive.reward as Address,
                abi: erc20Abi,
                functionName: "symbol",
                args: [],
            })
        ])

        incentives.push({
            ...incentive,
            vault: strategy.vault,
            rewardDecimals: decimals,
            rewardSymbol: symbol,
        });
    }

    return incentives;
}; 