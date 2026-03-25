import { Address } from "viem";

import { UserDistribution } from "../interfaces/Distribution";
import { BlockTimestampCache } from "../utils/chain";
import { computeTwabSnapshots } from "../utils/twab";
import { blockAtOrAfter, blockAtOrBefore } from "../utils/chain";
import { ResolvedWrapper } from "./registry";

/**
 * Expand wrapper allocations for a single IncentiveDistribution's user list.
 *
 * For each user that is a known wrapper, run a sub-TWAB among its depositors
 * and replace the wrapper entry with per-depositor allocations.
 *
 * Works with any integration that implements WrapperIntegration.
 */
export async function expandWrapperAllocations(
    client: any,
    users: UserDistribution[],
    wrapperMap: Map<Address, ResolvedWrapper>,
    startTimestamp: number,
    endTimestamp: number,
    currentBlockNumber: bigint,
    blockTimestampCache: BlockTimestampCache,
): Promise<UserDistribution[]> {
    const regularUsers: UserDistribution[] = [];
    const depositorAmounts = new Map<Address, bigint>();

    for (const userDist of users) {
        const resolved = wrapperMap.get(userDist.user);
        if (!resolved) {
            regularUsers.push(userDist);
            continue;
        }

        const wrapperAmount = BigInt(userDist.amount);
        if (wrapperAmount === 0n) continue;

        const { integration, context } = resolved;
        console.log(`  🔄 Expanding wrapper ${userDist.user} via ${integration.name}`);

        // Find block range for the window
        const startBlock = await blockAtOrAfter(
            client, startTimestamp, 0n, currentBlockNumber, blockTimestampCache,
        );
        const endBlock = await blockAtOrBefore(
            client, endTimestamp, startBlock, currentBlockNumber, blockTimestampCache,
        );

        if (endBlock < startBlock) {
            // Can't determine blocks — credit wrapper itself
            regularUsers.push(userDist);
            continue;
        }

        const snapshotBlock = startBlock > 0n ? startBlock - 1n : startBlock;

        // Discover depositors (current + historical)
        const depositors = await integration.getDepositors(context, startBlock, endBlock);
        if (depositors.length === 0) {
            regularUsers.push(userDist);
            continue;
        }

        // Get initial balances and transfer logs from the integration
        const initialBalances = await integration.getBalancesAtBlock(context, depositors, snapshotBlock);

        const totalSupply = await integration.getTotalSupply(context, snapshotBlock);
        const sumBalances = [...initialBalances.values()].reduce((a, b) => a + b, 0n);
        if (sumBalances < totalSupply) {
            console.error(`Sum of balances (${sumBalances}) < totalSupply (${totalSupply}) for wrapper ${userDist.user} at block ${snapshotBlock}`);
            process.exit(1);
        }

        const transferLogs = await integration.getTransferLogs(context, startBlock, endBlock);

        const globalStart = BigInt(startTimestamp);
        const globalEnd = BigInt(endTimestamp);
        const checkpoints = [globalStart, globalEnd];

        // Run sub-TWAB with the same engine
        const snapshots = await computeTwabSnapshots(
            client,
            transferLogs,
            checkpoints,
            globalStart,
            globalEnd,
            initialBalances,
            blockTimestampCache,
        );

        // Compute per-depositor weights (end snapshot - start snapshot)
        const startWeights = snapshots.get(globalStart) ?? new Map<Address, bigint>();
        const endWeights = snapshots.get(globalEnd) ?? new Map<Address, bigint>();

        const weights = new Map<Address, bigint>();
        let totalWeight = 0n;
        for (const address of new Set([...startWeights.keys(), ...endWeights.keys()])) {
            const delta = (endWeights.get(address) ?? 0n) - (startWeights.get(address) ?? 0n);
            if (delta > 0n) {
                weights.set(address, delta);
                totalWeight += delta;
            }
        }

        if (totalWeight === 0n) {
            // No activity — credit wrapper itself
            regularUsers.push(userDist);
            continue;
        }

        // Allocate the wrapper's total amount proportionally
        const sortedDepositors = Array.from(weights.entries())
            .sort((a, b) => Number(b[1] - a[1]));

        let allocated = 0n;
        for (let i = 0; i < sortedDepositors.length; i++) {
            const [depositor, weight] = sortedDepositors[i];
            const amount = i === sortedDepositors.length - 1
                ? wrapperAmount - allocated
                : (wrapperAmount * weight) / totalWeight;
            allocated += amount;

            // Accumulate — a depositor might also hold vault tokens directly
            const existing = depositorAmounts.get(depositor) ?? 0n;
            depositorAmounts.set(depositor, existing + amount);
        }

        console.log(`    ✅ Expanded to ${sortedDepositors.length} depositors`);
    }

    // Merge depositor allocations with regular users
    for (const user of regularUsers) {
        const extra = depositorAmounts.get(user.user);
        if (extra !== undefined) {
            // User is both a direct holder and a wrapper depositor — sum amounts
            const total = BigInt(user.amount) + extra;
            user.amount = total.toString();
            depositorAmounts.delete(user.user);
        }
    }

    // Add remaining depositors (those who only held via wrapper)
    for (const [depositor, amount] of depositorAmounts.entries()) {
        regularUsers.push({
            user: depositor,
            balance: "0",
            share: "0.000000",
            amount: amount.toString(),
        });
    }

    return regularUsers;
}
