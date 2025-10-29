import { Address } from "viem";

import { BlockTimestampCache, TransferLog, getBlockTimestamp } from "./chain";

export const SECONDS_PER_SHARE_SCALE = 10n ** 36n;

interface HolderState {
    balance: bigint;
    lastAccumulator: bigint;
    twabWeight: bigint;
}

export type SnapshotMap = Map<bigint, Map<Address, bigint>>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const computeTwabSnapshots = async (
    client: any,
    logs: TransferLog[],
    checkpoints: bigint[],
    startTimestamp: bigint,
    endTimestamp: bigint,
    initialBalances: Map<Address, bigint>,
    blockTimestampCache: BlockTimestampCache,
): Promise<SnapshotMap> => {
    // 1. Prime state with balances at the snapshot block.
    const holders = new Map<Address, HolderState>();
    let totalSupply = 0n;

    for (const [addr, balance] of initialBalances.entries()) {
        holders.set(addr, {
            balance,
            lastAccumulator: 0n,
            twabWeight: 0n,
        });
        totalSupply += balance;
    }

    // 2. secondsPerVaultShare tracks "seconds of vault life per single share" (scaled by 1e36).
    let secondsPerVaultShare = 0n;
    let currentTimestamp = startTimestamp;

    // 3. Flush the "seconds per share" tracker into one holder before we touch their balance.
    const settleHolder = (address: Address): HolderState => {
        let state = holders.get(address);
        if (!state) {
            state = { balance: 0n, lastAccumulator: secondsPerVaultShare, twabWeight: 0n };
            holders.set(address, state);
        }
        const delta = secondsPerVaultShare - state.lastAccumulator;
        if (delta !== 0n && state.balance !== 0n) {
            state.twabWeight += state.balance * delta;
        }
        state.lastAccumulator = secondsPerVaultShare;
        return state;
    };

    // 4. Flush the tracker for all holders (used when we take a snapshot).
    const settleAllHolders = () => {
        for (const state of holders.values()) {
            const delta = secondsPerVaultShare - state.lastAccumulator;
            if (delta !== 0n && state.balance !== 0n) {
                state.twabWeight += state.balance * delta;
            }
            state.lastAccumulator = secondsPerVaultShare;
        }
    };

    // 5. Move the clock forward and add "seconds / totalSupply" to the running tracker.
    const advanceTo = (target: bigint) => {
        if (target <= currentTimestamp) {
            currentTimestamp = target;
            return;
        }
        if (totalSupply > 0n) {
            const delta = target - currentTimestamp;
            secondsPerVaultShare += (delta * SECONDS_PER_SHARE_SCALE) / totalSupply;
        }
        currentTimestamp = target;
    };

    const snapshots: SnapshotMap = new Map();
    const sortedCheckpoints = checkpoints.filter((ts) => ts >= startTimestamp && ts <= endTimestamp);
    sortedCheckpoints.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    let checkpointIndex = 0;

    // 6. Replay each transfer chronologically, settling holders before balances move.
    for (const log of logs) {
        const eventTs = BigInt(await getBlockTimestamp(client, log.blockNumber, blockTimestampCache));
        if (eventTs < startTimestamp || eventTs > endTimestamp) continue;

        while (checkpointIndex < sortedCheckpoints.length && sortedCheckpoints[checkpointIndex] <= eventTs) {
            const ts = sortedCheckpoints[checkpointIndex];
            advanceTo(ts);
            settleAllHolders();
            const snapshot = new Map<Address, bigint>();
            for (const [addr, state] of holders.entries()) snapshot.set(addr, state.twabWeight);
            snapshots.set(ts, snapshot);
            checkpointIndex++;
        }

        advanceTo(eventTs);

        if (log.from !== ZERO_ADDRESS) {
            settleHolder(log.from).balance -= log.value;
        } else {
            totalSupply += log.value;
        }

        if (log.to !== ZERO_ADDRESS) {
            settleHolder(log.to).balance += log.value;
        } else {
            totalSupply -= log.value;
        }
    }

    // 7. Flush any checkpoints that happen after the last transfer.
    while (checkpointIndex < sortedCheckpoints.length) {
        const ts = sortedCheckpoints[checkpointIndex];
        advanceTo(ts);
        settleAllHolders();
        const snapshot = new Map<Address, bigint>();
        for (const [addr, state] of holders.entries()) snapshot.set(addr, state.twabWeight);
        snapshots.set(ts, snapshot);
        checkpointIndex++;
    }

    // 8. Ensure the window boundaries themselves are present in the snapshot map.
    if (!snapshots.has(startTimestamp)) {
        const snapshot = new Map<Address, bigint>();
        for (const [addr, state] of holders.entries()) snapshot.set(addr, state.twabWeight);
        snapshots.set(startTimestamp, snapshot);
    }

    if (!snapshots.has(endTimestamp)) {
        advanceTo(endTimestamp);
        settleAllHolders();
        const snapshot = new Map<Address, bigint>();
        for (const [addr, state] of holders.entries()) snapshot.set(addr, state.twabWeight);
        snapshots.set(endTimestamp, snapshot);
    }

    return snapshots;
};
