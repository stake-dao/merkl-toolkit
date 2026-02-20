import { mainnet } from "viem/chains";
import { MERKL_CONTRACT, NULL_ADDRESS } from "../constants";
import { getClient } from "./rpc";
import { IncentiveExtended, IncentiveSource } from "../interfaces/IncentiveExtended";
import { Incentive } from "../interfaces/Incentive";
import { Address, erc20Abi, getAddress } from "viem";
import axios from "axios";
import { Strategy } from "../interfaces/Strategy";
import { merklAbi } from "../abis/Merkl";

// Known VoteMarket IncentiveGaugeHook addresses (Arbitrum → Mainnet bridge senders)
// Update when a new hook version is deployed (see contracts-monorepo/packages/periphery/script/votemarket-infra/)
const VM_HOOK_ADDRESSES: Set<Address> = new Set([
    getAddress("0x06Ab7052b00d038F8EeF33B267C23b5154cE8cDc"), // hook v1
    getAddress("0x68654D460fDF3231B49B25817cBBD72d8d291Fcf"), // hook v2
]);

export const getIncentiveSource = (sender: string): IncentiveSource => {
    try {
        return VM_HOOK_ADDRESSES.has(getAddress(sender)) ? "vm" : "direct";
    } catch {
        return "direct";
    }
};

const url = "https://raw.githubusercontent.com/stake-dao/api/main"
const PROTOCOLS = ["v2/balancer", "v2/curve", "pendle"];
const V2_CURVE_CHAIN_IDS = [1]

interface ProtocolStrategies {
    protocol: string;
    strategies: Strategy[];
}

const getAllStakeDaoStrategies = async (): Promise<ProtocolStrategies[]> => {
    const datas = await Promise.all(PROTOCOLS.map((protocol) => {
        if (!protocol.startsWith("v2")) {
            return [axios.get(`${url}/api/strategies/${protocol}/1.json`)]
        }

        return V2_CURVE_CHAIN_IDS.map((chainId) => axios.get(`${url}/api/strategies/${protocol}/${chainId}.json`))
    }).flat());

    return PROTOCOLS.map((protocol) => {
        const data = datas.shift();
        return {
            protocol,
            strategies: data.data?.deployed || data.data || [],
        }
    }) as ProtocolStrategies[];
};

export const getMerklLastId = async (): Promise<number> => {
    const client = await getClient(1);

    return Number(await client.readContract({
        address: MERKL_CONTRACT,
        abi: merklAbi,
        functionName: "nbIncentives",
        args: [],
    }));
};

export const getNewIncentives = async (fromId: number, toId: number): Promise<IncentiveExtended[]> => {

    const protocolStrategies = await getAllStakeDaoStrategies();

    const client = await getClient(mainnet.id);
    const incentives: IncentiveExtended[] = [];

    for (let i = fromId; i < toId; i++) {
        const incentive = (await client.readContract({
            address: MERKL_CONTRACT,
            abi: merklAbi,
            functionName: "incentives",
            args: [BigInt(i)],
        })) as Incentive;

        if (getAddress(incentive[1]) === NULL_ADDRESS && BigInt(incentive[7]) === BigInt(0)) {
            continue;
        }

        // Check if we have a gauge deployed
        let strategy: Strategy | undefined = undefined;
        for (const protocolStrategy of protocolStrategies) {
            if (protocolStrategy.protocol === 'pendle') {
                strategy = protocolStrategy.strategies.find((s) => s?.lpToken?.address?.toLocaleLowerCase() === incentive[0].toLowerCase());
            } else {
                strategy = protocolStrategy.strategies.find((s) => s.gaugeAddress.toLocaleLowerCase() === incentive[0].toLowerCase());
            }

            if (strategy) {
                break;
            }
        }

        if (!strategy) {
            continue;
        }

        // Fetch token data
        const [decimals, symbol] = await Promise.all([
            client.readContract({
                address: incentive[1] as Address,
                abi: erc20Abi,
                functionName: "decimals",
                args: [],
            }),
            client.readContract({
                address: incentive[1] as Address,
                abi: erc20Abi,
                functionName: "symbol",
                args: [],
            })
        ])

        incentives.push({
            id: i,
            gauge: incentive[0],
            reward: incentive[1],
            duration: incentive[2],
            start: incentive[3],
            end: incentive[4],
            fromChainId: incentive[5],
            sender: incentive[6],
            amount: incentive[7],
            manager: incentive[8],
            vault: strategy.vault,
            rewardDecimals: decimals,
            rewardSymbol: symbol,
            ended: false,
            distributedUntil: incentive[3],
            source: getIncentiveSource(incentive[6]),
        });
    }

    return incentives;
};
