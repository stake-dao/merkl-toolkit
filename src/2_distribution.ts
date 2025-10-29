import { mainnet } from "viem/chains";
import { Address, isAddress } from "viem";

import { getIncentives } from "./utils/incentives";
import { getClient } from "./utils/rpc";
import { getTokenHolders } from "./utils/token";
import { TokenHolderScanner } from "./utils/tokenHolderScanner";
import { rmAndCreateDistributionDir, writeDistribution, writeDistributionGaugeData } from "./utils/distribution";
import { getLastDistributionsData, writeLastDistributionData } from "./utils/distributionData";

import { Distribution, IncentiveDistribution } from "./interfaces/Distribution";
/**
 * Distribution
 *
 * High-level flow per job run:
 *   1. Load unsent incentives and slice them to the current [start, end) window.
 *   2. For each vault, replay the share token transfer history once via computeTwabSnapshots.
 *   3. Convert TWAB weights into token payouts and persist both the incentive list and the
 *      per-window debug snapshots used for auditing.
 *
 * The heavy lifting (log pagination, seconds-per-share math) lives in utils/twab.
 */

import { GaugeHolders, GaugeWindowSnapshot } from "./interfaces/GaugeHolders";
import { TokenHolder } from "./interfaces/TokenHolder";
import { IncentiveExtended } from "./interfaces/IncentiveExtended";

import { computeTwabSnapshots } from "./utils/twab";
import { blockAtOrAfter, blockAtOrBefore, fetchTransferLogs } from "./utils/chain";

const SHARE_DECIMALS = 6;
const ZERO_SHARE = `0.${"0".repeat(SHARE_DECIMALS)}`;
const FULL_SHARE = `100.${"0".repeat(SHARE_DECIMALS)}`;

const formatSharePercent = (weight: bigint, totalWeight: bigint, decimals = SHARE_DECIMALS): string => {
    if (totalWeight === 0n || weight === 0n) {
        return `0.${"0".repeat(decimals)}`;
    }
    const scale = 10n ** BigInt(decimals);
    const percentScaled = (weight * 100n * scale) / totalWeight;
    const integerPart = percentScaled / scale;
    const fractionalPart = percentScaled % scale;
    return `${integerPart}.${fractionalPart.toString().padStart(decimals, "0")}`;
};

type IncentiveWindow = {
    incentive: IncentiveExtended;
    startTimestamp: number;
    endTimestamp: number;
    amountToDistribute: bigint;
    incentivePerSecond: bigint;
};

/**
 * Group incentives by vault and clamp each one to the active [last run, now] window.
 * Rewards that ended before the previous checkpoint are ignored. The amount distributed
 * in this run is simply (elapsed seconds in window) * (incentive rate).
 */
const toWindowsByVault = (
    incentives: IncentiveExtended[],
    lastTimestamp: number,
    now: number,
) => {
    const windowsByVault = new Map<Address, IncentiveWindow[]>();

    for (const incentive of incentives) {
        if (!isAddress(incentive.vault)) {
            throw new Error(`${incentive.vault} is not a correct Address`);
        }

        const windowStart = Math.max(lastTimestamp, Number(incentive.start));
        const windowEnd = Math.min(now, Number(incentive.end));
        const fullDuration = Number(incentive.end - incentive.start);

        if (fullDuration <= 0 || windowStart >= windowEnd) continue;

        const amount = BigInt(incentive.amount);
        const perSecond = amount / BigInt(fullDuration);
        const elapsed = BigInt(windowEnd - windowStart);

        const windows = windowsByVault.get(incentive.vault as Address) ?? [];
        windows.push({
            incentive,
            startTimestamp: windowStart,
            endTimestamp: windowEnd,
            amountToDistribute: perSecond * elapsed,
            incentivePerSecond: perSecond,
        });
        windowsByVault.set(incentive.vault as Address, windows);
    }

    return windowsByVault;
};

/**
 * Replay the share token history exactly once for a vault by:
 *   - Binary-searching the block range that brackets the first/last window timestamp.
 *   - Fetching balances at startBlock - 1 so we know every holder’s starting balance.
 *   - Streaming transfer events and capturing accumulator values at every checkpoint.
 */
const buildSnapshots = async (
    client: any,
    vault: Address,
    windows: IncentiveWindow[],
    currentBlockNumber: bigint,
    cache: Map<string, number>,
    mainnetRpcUrl: string,
) => {
    const sorted = [...windows].sort((a, b) => a.startTimestamp - b.startTimestamp);
    const globalStart = BigInt(sorted[0].startTimestamp);
    const globalEnd = BigInt(sorted[sorted.length - 1].endTimestamp);

    // 1. Find the block span that straddles the whole window.
    const startBlock = await blockAtOrAfter(client, sorted[0].startTimestamp, 0n, currentBlockNumber, cache);
    const endBlock = await blockAtOrBefore(client, sorted[sorted.length - 1].endTimestamp, startBlock, currentBlockNumber, cache);

    if (endBlock < startBlock) {
        console.warn(`⚠️ Invalid block range for vault ${vault}. Skipping.`);
        return null;
    }

    const snapshotBlock = startBlock > 0n ? startBlock - 1n : startBlock;
    // 2. Gather starting balances and every transfer affecting the vault.
    const holdersInfo = await getTokenHolders(vault, Number(endBlock));
    const scanner = new TokenHolderScanner(mainnetRpcUrl, vault);
    const initialBalances = await scanner.getBalancesAtBlock(holdersInfo.users, snapshotBlock);

    const logs = await fetchTransferLogs(client, vault, startBlock, endBlock);
    const checkpoints = Array.from(
        new Set(
            sorted.flatMap((window) => [BigInt(window.startTimestamp), BigInt(window.endTimestamp)]).concat([globalStart, globalEnd]),
        ),
    );

    // 3. Replay the transfers once and return the snapshots map.
    return computeTwabSnapshots(client, logs, checkpoints, globalStart, globalEnd, initialBalances, cache);
};

const toDistributionForWindow = (
    window: IncentiveWindow,
    snapshots: Map<bigint, Map<Address, bigint>>,
) => {
    // Subtract snapshots to obtain raw TWAB weight earned inside this window.
    const startWeights = snapshots.get(BigInt(window.startTimestamp)) ?? new Map<Address, bigint>();
    const endWeights = snapshots.get(BigInt(window.endTimestamp)) ?? new Map<Address, bigint>();

    const weights = new Map<Address, bigint>();
    for (const address of new Set([...startWeights.keys(), ...endWeights.keys()])) {
        const start = startWeights.get(address) ?? 0n;
        const end = endWeights.get(address) ?? 0n;
        const delta = end - start;
        if (delta > 0n) {
            weights.set(address, delta);
        }
    }

    const entries = Array.from(weights.entries()).sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : Number(b[1] - a[1])));
    const totalWeight = entries.reduce((acc, [, weight]) => acc + weight, 0n);

    if (entries.length === 0 || totalWeight === 0n) {
        const share = window.amountToDistribute === 0n ? ZERO_SHARE : FULL_SHARE;
        return {
            users: [
                {
                    user: window.incentive.manager as Address,
                    balance: "0",
                    share,
                    amount: window.amountToDistribute.toString(),
                },
            ],
            holders: [
                {
                    user: window.incentive.manager as Address,
                    weight: "0",
                    sharePercentage: share,
                },
            ],
        };
    }

    let allocated = 0n;
    const users = entries.map(([address, weight], index) => {
        const amount = index === entries.length - 1
            ? window.amountToDistribute - allocated
            : (window.amountToDistribute * weight) / totalWeight;
        allocated += amount;
        return {
            user: address,
            balance: weight.toString(),
            share: formatSharePercent(weight, totalWeight, SHARE_DECIMALS),
            amount: amount.toString(),
        };
    });

    const holders: TokenHolder[] = entries.map(([address, weight]) => ({
        user: address,
        weight: weight.toString(),
        sharePercentage: formatSharePercent(weight, totalWeight, SHARE_DECIMALS),
    }));

    return { users, holders };
};

export const distribute = async () => {
    const mainnetRpcUrl = process.env.MAINNET_RPC_URL;
    if (!mainnetRpcUrl) {
        throw new Error("MAINNET_RPC_URL is not set in environment");
    }

    const client = await getClient(mainnet.id);
    const currentBlock = await client.getBlock();
    const currentTimestamp = Number(currentBlock.timestamp);

    const incentives = await getIncentives();
    const lastDistributions = getLastDistributionsData();
    const lastDistributionTimestamp =
        lastDistributions.length === 0 ? 0 : lastDistributions[lastDistributions.length - 1].timestamp;

    const activeIncentives = incentives.filter((incentive) => Number(incentive.end) > lastDistributionTimestamp);
    if (activeIncentives.length === 0) {
        console.log("⚠️ No active incentives after last distribution timestamp:", lastDistributionTimestamp);
        return;
    }

    console.log(`✅ Found ${activeIncentives.length} active incentives at timestamp ${currentTimestamp}`);
    activeIncentives.forEach((incentive, idx) => {
        console.log(
            `  #${idx} gauge=${incentive.gauge} reward=${incentive.reward} endsAt=${Number(incentive.end)}`,
        );
    });
    console.log("");

    // 1. Cut each incentive to this run's [start, end) window.
    const windowsByVault = toWindowsByVault(activeIncentives, lastDistributionTimestamp, currentTimestamp);
    if (windowsByVault.size === 0) {
        console.log("⚠️ No windows to distribute in this run.");
        return;
    }

    rmAndCreateDistributionDir(currentTimestamp);

    // 2. For each vault replay historical transfers and collect TWAB weights.
    const blockTimestampCache = new Map<string, number>();
    const currentBlockNumber = currentBlock.number as bigint;
    const allIncentiveDistributions: IncentiveDistribution[] = [];

    for (const [vault, windows] of windowsByVault.entries()) {
        // Replaying once per vault keeps the job efficient even for many overlapping incentives.
        const snapshots = await buildSnapshots(
            client,
            vault,
            windows,
            currentBlockNumber,
            blockTimestampCache,
            mainnetRpcUrl,
        );

        if (!snapshots) {
            continue;
        }

        const gaugeWindowsSnapshots: GaugeWindowSnapshot[] = [];

        // Walk windows chronologically: each one consumes two snapshots (start/end)
        // and translates them into per-user claim amounts.
        for (const window of windows.sort((a, b) => a.startTimestamp - b.startTimestamp)) {
            const { users, holders } = toDistributionForWindow(window, snapshots);

            allIncentiveDistributions.push({
                vault,
                token: {
                    address: window.incentive.reward as Address,
                    decimals: window.incentive.rewardDecimals,
                    symbol: window.incentive.rewardSymbol,
                },
                distribution: {
                    incentivePerSecond: window.incentivePerSecond,
                    amountToDistribute: window.amountToDistribute,
                    incentiveId: window.incentive.id,
                },
                users,
            });

            gaugeWindowsSnapshots.push({
                incentiveId: window.incentive.id,
                startTimestamp: window.startTimestamp,
                endTimestamp: window.endTimestamp,
                holders,
            });
        }

        const gaugeSnapshot: GaugeHolders = {
            vault,
            windows: gaugeWindowsSnapshots,
        };
        writeDistributionGaugeData(currentTimestamp, gaugeSnapshot);
    }

    // 3. Persist the distribution artifact for the Merkle step.
    const distribution: Distribution = {
        blockNumber: Number(currentBlock.number),
        timestamp: currentTimestamp,
        incentives: allIncentiveDistributions,
    };

    writeDistribution(distribution);
    writeLastDistributionData({
        blockNumber: Number(currentBlock.number),
        timestamp: currentTimestamp,
        sentOnchain: false,
    });
};
