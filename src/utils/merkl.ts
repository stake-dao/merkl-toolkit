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

// Known AllMight addresses
// Update when AllMight addresses changes
const ALL_MIGHT_ADDRESSES: Set<Address> = new Set([
    getAddress("0xDBd24b092f686b12650EC1450e3A7138F714506c"), // mainnet
]);

export const getIncentiveSource = (sender: string): IncentiveSource => {
    try {
        if (VM_HOOK_ADDRESSES.has(getAddress(sender))) return 'vm';
        if (ALL_MIGHT_ADDRESSES.has(getAddress(sender))) return 'gauge';

        return "direct";
    } catch {
        return "direct";
    }
};

// Returns the timestamp of the next Thursday 01:00 UTC strictly after `start`.
// If `start` falls on a Thursday, jumps to the following week's Thursday
// (i.e., +7 days), never the same calendar day.
const nextThursdayOneAmUTC = (start: bigint): bigint => {
    const d = new Date(Number(start) * 1000);
    const day = d.getUTCDay(); // 0=Sun .. 4=Thu .. 6=Sat
    let daysToAdd = (4 - day + 7) % 7;
    if (daysToAdd === 0) daysToAdd = 7; // start IS Thursday → roll to next week's Thu
    const nextThuMs = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate() + daysToAdd,
        1, 0, 0, 0
    );
    return BigInt(Math.floor(nextThuMs / 1000));
};

// Forces the LM cycle end to align with the CRV cycle reset at Thursday
// 01:00 UTC. For VM hook bridges, start is always Thursday or Friday, so
// "next Thursday 01:00 UTC after start" lands on the upcoming Thursday's
// 01:00 UTC — exactly when CRV restarts → no APR overlap.
// Only applies to incentives bridged via VoteMarket hooks (source === "vm")
// whose end is still in the future.
const adjustEndForVmHook = (source: IncentiveSource, start: bigint, end: bigint): bigint => {
    if (source !== "vm") return end;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (end <= nowSec) return end;
    return nextThursdayOneAmUTC(start);
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

        const source = getIncentiveSource(incentive[6]);
        const adjustedEnd = adjustEndForVmHook(source, incentive[3], incentive[4]);
        if (adjustedEnd !== incentive[4]) {
            console.log(`⏱️  Incentive #${i} VM end shifted: ${incentive[4]} → ${adjustedEnd} (next Thu 01:00 UTC from start)`);
        }

        incentives.push({
            id: i,
            gauge: incentive[0],
            reward: incentive[1],
            duration: incentive[2],
            start: incentive[3],
            end: adjustedEnd,
            fromChainId: incentive[5],
            sender: incentive[6],
            amount: incentive[7],
            manager: incentive[8],
            vault: strategy.vault,
            rewardDecimals: decimals,
            rewardSymbol: symbol,
            ended: false,
            distributedUntil: incentive[3],
            source,
        });
    }

    return incentives;
};
