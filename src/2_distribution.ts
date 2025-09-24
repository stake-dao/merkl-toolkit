import { mainnet } from "viem/chains";
import { getIncentives } from "./utils/incentives";
import { getClient } from "./utils/rpc";
import { Address, isAddress } from "viem";
import { getTokenHolders } from "./utils/token";
import { GaugeHolders } from "./interfaces/GaugeHolders";
import fs from 'fs';
import path from 'path';
import { safeStringify } from "./utils/parse";
import { getLastDistributionsData, writeLastDistributionData } from "./utils/distributionData";
import { Distribution, IncentiveDistribution } from "./interfaces/Distribution";
import { rmAndCreateDistributionDir, writeDistribution, writeDistributionGaugeData } from "./utils/distribution";

export const distribute = async () => {
    // Fetch current block data
    const client = await getClient(mainnet.id);
    const currentBlock = await client.getBlock();

    const currentTimestamp = Number(currentBlock.timestamp);

    // Get incentives
    const incentives = await getIncentives();

    // For each incentives still active, fetch gauge holders
    const lastDistributions = getLastDistributionsData()
    const lastTimestamp = lastDistributions.length === 0 ? currentTimestamp : lastDistributions[lastDistributions.length - 1].timestamp;

    const incentivesAlive = incentives.filter((incentive) => incentive.end > lastTimestamp);
    if (incentivesAlive.length === 0) {
        console.log("⚠️ No active incentives at this timestamp:", currentTimestamp);
        console.log("⚠️ Last distribution timestamp was : ", lastTimestamp)
        return
    }

    // Log active incentives
    console.log(
        `✅ Found ${incentivesAlive.length} active incentives at timestamp ${currentTimestamp}`
    );

    for (const [i, incentive] of incentivesAlive.entries()) {
        console.log(
            `  #${i} gauge=${incentive.gauge} reward=${incentive.reward} endsAt=${incentive.end}`
        );
    }
    console.log("\n");

    const gaugesMap: Record<Address, boolean> = {};
    for (const incentive of incentivesAlive) {
        if (isAddress(incentive.vault)) {
            gaugesMap[incentive.vault as Address] = true;
        } else {
            throw new Error(`${incentive.vault} is not a correct Address`);
        }

    }

    // Create distribution dir
    rmAndCreateDistributionDir(currentTimestamp);

    const gaugesHolders: GaugeHolders[] = [];
    const vaults = Object.keys(gaugesMap) as Address[];
    for (const vault of vaults) {
        const holders = await getTokenHolders(vault);
        const gaugeHolders: GaugeHolders = {
            vault,
            holders
        };

        gaugesHolders.push(gaugeHolders);

        // Write gauge data
        writeDistributionGaugeData(currentTimestamp, gaugeHolders);
    }

    // Compute the distribution
    const lastDistributionTimestamp = lastDistributions.length === 0 ? 0 : lastDistributions[lastDistributions.length - 1].timestamp;

    const currentIncentiveToDistribute: IncentiveDistribution[] = [];
    for (const incentive of incentivesAlive) {
        const gaugeHolders = gaugesHolders.find((g) => g.vault.toLowerCase() === incentive.vault.toLowerCase());
        if (!gaugeHolders) {
            throw new Error(`Error when finding gauge holders for gauge ${incentive.vault}`);
        }

        const totalIncentiveTime = Number(incentive.end - incentive.start);
        const incentiveAmount = BigInt(incentive.amount);
        const incentivePerSecond = incentiveAmount / BigInt(totalIncentiveTime);

        // Clamp current time to the end of the incentive
        const effectiveNow = Math.min(currentTimestamp, Number(incentive.end));

        let secSinceLastDistribution: number = 0;
        if (lastDistributionTimestamp < Number(incentive.start)) {
            // If last distribution is before the start, count from the start
            secSinceLastDistribution = effectiveNow - Number(incentive.start);
        } else {
            // Otherwise, count from last distribution
            secSinceLastDistribution = effectiveNow - lastDistributionTimestamp;
        }

        // Ensure no negative values
        if (secSinceLastDistribution < 0) {
            secSinceLastDistribution = 0;
        }

        const amountToDistribute = incentivePerSecond * BigInt(secSinceLastDistribution);

        const totalSupply = gaugeHolders.holders.reduce((acc: bigint, user) => acc + BigInt(user.balance), BigInt(0));

        const incentiveDistribution: IncentiveDistribution = {
            vault: incentive.vault as Address,
            token: {
                address: incentive.reward as Address,
                decimals: incentive.rewardDecimals,
                symbol: incentive.rewardSymbol,
            },
            distribution: {
                incentivePerSecond,
                amountToDistribute,
                incentiveId: incentive.id,
            },
            users: gaugeHolders.holders.map((user) => {
                const share = (BigInt(user.balance) * 10n ** BigInt(incentive.rewardDecimals)) / totalSupply;
                const shareStr = (Number(share) / Number(10n ** BigInt(incentive.rewardDecimals))) * 100;

                const userAmount = (BigInt(user.balance) * amountToDistribute) / totalSupply;

                return {
                    balance: user.balance,
                    user: user.user,
                    amount: userAmount.toString(),
                    share: shareStr.toString(),
                }
            }),
        };

        currentIncentiveToDistribute.push(incentiveDistribution);
    }

    const currentDistribution: Distribution = {
        blockNumber: Number(currentBlock.number),
        timestamp: currentTimestamp,
        incentives: currentIncentiveToDistribute
    };

    writeDistribution(currentDistribution);
    writeLastDistributionData({
        blockNumber: Number(currentBlock.number),
        timestamp: currentTimestamp,
        sentOnchain: false,
    });
};