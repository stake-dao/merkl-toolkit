import { Address, parseAbiItem } from "viem";

/**
 * TWAB helpers
 *
 * These utilities are the “engine room” for the vault distribution script:
 *   - fetchTransferLogs paginates ERC20 Transfer events without double counting.
 *   - blockAtOr{After,Before} perform timestamp → block binary searches with memoisation.
 *   - computeTwabSnapshots replays the full transfer history once and materialises the
 *     accumulator value at every timestamp we care about. Downstream code can then subtract
 *     snapshots to obtain each holder’s time-weighted share for any window.
 */
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export const ACCUMULATOR_PRECISION = 10n ** 36n;
export const DEFAULT_LOG_CHUNK_SIZE = 20_000n;

export type BlockTimestampCache = Map<string, number>;

export interface TransferLog {
    blockNumber: bigint;
    logIndex: number;
    from: Address;
    to: Address;
    value: bigint;
}

interface HolderState {
    balance: bigint;
    lastAccumulator: bigint;
    twabWeight: bigint;
}

export type SnapshotMap = Map<bigint, Map<Address, bigint>>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const toCacheKey = (block: bigint): string => block.toString();

export const formatSharePercent = (weight: bigint, totalWeight: bigint, decimals = 6): string => {
    if (totalWeight === 0n || weight === 0n) {
        return `0.${"0".repeat(decimals)}`;
    }

    const scale = 10n ** BigInt(decimals);
    const percentScaled = (weight * 100n * scale) / totalWeight;
    const integerPart = percentScaled / scale;
    const fractionalPart = percentScaled % scale;
    return `${integerPart}.${fractionalPart.toString().padStart(decimals, "0")}`;
};

export const fetchTransferLogs = async (
    client: any,
    token: Address,
    fromBlock: bigint,
    toBlock: bigint,
    chunkSize: bigint = DEFAULT_LOG_CHUNK_SIZE,
) : Promise<TransferLog[]> => {
    /**
     * Walk the block range in fixed-size chunks. Providers often reject “too wide” log queries,
     * so we degrade gracefully by slicing the range and sorting the combined result afterwards.
     */
    const logs: TransferLog[] = [];

    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
        const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
        const chunkLogs = await client.getLogs({
            address: token,
            event: TRANSFER_EVENT,
            fromBlock: start,
            toBlock: end,
        });

        for (const log of chunkLogs) {
            logs.push({
                blockNumber: log.blockNumber!,
                logIndex: Number(log.logIndex ?? 0n),
                from: log.args?.from as Address,
                to: log.args?.to as Address,
                value: BigInt(log.args?.value ?? 0n),
            });
        }
    }

    logs.sort((a, b) => {
        if (a.blockNumber === b.blockNumber) {
            return a.logIndex - b.logIndex;
        }
        return a.blockNumber < b.blockNumber ? -1 : 1;
    });

    return logs;
};

export const getBlockTimestamp = async (
    client: any,
    blockNumber: bigint,
    cache: BlockTimestampCache,
): Promise<number> => {
    const key = toCacheKey(blockNumber);
    if (cache.has(key)) {
        return cache.get(key)!;
    }
    const block = await client.getBlock({ blockNumber });
    const timestamp = Number(block.timestamp);
    cache.set(key, timestamp);
    return timestamp;
};

export const blockAtOrAfter = async (
    client: any,
    targetTimestamp: number,
    lowerBound: bigint,
    upperBound: bigint,
    cache: BlockTimestampCache,
): Promise<bigint> => {
    /**
     * Classic binary search: narrow the block interval until (timestamp >= target). We cache
    * intermediate timestamps so subsequent searches across overlapping ranges are cheap. */
    let low = lowerBound;
    let high = upperBound;

    while (low < high) {
        const mid = (low + high) / 2n;
        const midTs = await getBlockTimestamp(client, mid, cache);
        if (midTs < targetTimestamp) {
            low = mid + 1n;
        } else {
            high = mid;
        }
    }

    return low;
};

export const blockAtOrBefore = async (
    client: any,
    targetTimestamp: number,
    lowerBound: bigint,
    upperBound: bigint,
    cache: BlockTimestampCache,
): Promise<bigint> => {
    /**
     * Same as blockAtOrAfter but mirrored to find the final block whose timestamp is <= target.
     */
    let low = lowerBound;
    let high = upperBound;

    while (low < high) {
        const mid = (low + high + 1n) / 2n;
        const midTs = await getBlockTimestamp(client, mid, cache);
        if (midTs > targetTimestamp) {
            high = mid - 1n;
        } else {
            low = mid;
        }
    }

    return low;
};

export const computeTwabSnapshots = async (
    client: any,
    logs: TransferLog[],
    checkpointTimestamps: bigint[],
    startTimestamp: bigint,
    endTimestamp: bigint,
    initialBalances: Map<Address, bigint>,
    blockTimestampCache: BlockTimestampCache,
): Promise<SnapshotMap> => {
    /**
     * Core TWAB routine:
     *   1. Prime holder balances from an on-chain snapshot (startBlock - 1).
     *   2. Replay the sorted transfer log and keep a running accumulator of ∑ dt / totalSupply.
     *   3. At the timestamps we care about, capture each holder’s integrated weight.
     *
     * Snapshot map keys are raw UNIX timestamps (as bigint). Consumers subtract two snapshots to
     * obtain the exact weight earned inside that window without replaying historical events.
     */
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

    let globalAccumulator = 0n;
    let currentTimestamp = startTimestamp;

    const syncHolder = (address: Address): HolderState => {
        let state = holders.get(address);
        if (!state) {
            state = {
                balance: 0n,
                lastAccumulator: globalAccumulator,
                twabWeight: 0n,
            };
            holders.set(address, state);
            return state;
        }

        const deltaAccumulator = globalAccumulator - state.lastAccumulator;
        if (deltaAccumulator !== 0n && state.balance !== 0n) {
            state.twabWeight += state.balance * deltaAccumulator;
        }
        state.lastAccumulator = globalAccumulator;
        return state;
    };

    const syncAllHolders = () => {
        for (const state of holders.values()) {
            const deltaAccumulator = globalAccumulator - state.lastAccumulator;
            if (deltaAccumulator !== 0n && state.balance !== 0n) {
                state.twabWeight += state.balance * deltaAccumulator;
            }
            state.lastAccumulator = globalAccumulator;
        }
    };

    const advanceTime = (target: bigint) => {
        if (target <= currentTimestamp) {
            currentTimestamp = target;
            return;
        }
        if (totalSupply > 0n) {
            const delta = target - currentTimestamp;
            globalAccumulator += (delta * ACCUMULATOR_PRECISION) / totalSupply;
        }
        currentTimestamp = target;
    };

    const snapshots: SnapshotMap = new Map();
    const uniqueCheckpoints = Array.from(new Set(checkpointTimestamps.filter((ts) => ts >= startTimestamp && ts <= endTimestamp)));
    uniqueCheckpoints.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    let checkpointIndex = 0;

    for (const log of logs) {
        // Translate block → timestamp once, honouring the global window boundary.
        const eventTimestamp = BigInt(await getBlockTimestamp(client, log.blockNumber, blockTimestampCache));
        if (eventTimestamp < startTimestamp || eventTimestamp > endTimestamp) {
            continue;
        }

        // Flush checkpoints that sit before or on this event so downstream consumers
        // can access exact accumulator values at each requested timestamp.
        while (checkpointIndex < uniqueCheckpoints.length && uniqueCheckpoints[checkpointIndex] <= eventTimestamp) {
            const checkpointTs = uniqueCheckpoints[checkpointIndex];
            advanceTime(checkpointTs);
            syncAllHolders();
            const snapshot = new Map<Address, bigint>();
            for (const [addr, state] of holders.entries()) {
                snapshot.set(addr, state.twabWeight);
            }
            snapshots.set(checkpointTs, snapshot);
            checkpointIndex++;
        }

        advanceTime(eventTimestamp);

        const participants: Address[] = [];
        if (log.from !== ZERO_ADDRESS) {
            participants.push(log.from);
        }
        if (log.to !== ZERO_ADDRESS) {
            participants.push(log.to);
        }

        for (const participant of participants) {
            syncHolder(participant);
        }

        if (log.from !== ZERO_ADDRESS) {
            const senderState = holders.get(log.from)!;
            senderState.balance -= log.value;
        } else {
            totalSupply += log.value;
        }

        if (log.to !== ZERO_ADDRESS) {
            const receiverState = syncHolder(log.to);
            receiverState.balance += log.value;
        } else {
            totalSupply -= log.value;
        }
    }

    // Drain any remaining checkpoints (e.g. end timestamp).
    while (checkpointIndex < uniqueCheckpoints.length) {
        const checkpointTs = uniqueCheckpoints[checkpointIndex];
        advanceTime(checkpointTs);
        syncAllHolders();
        const snapshot = new Map<Address, bigint>();
        for (const [addr, state] of holders.entries()) {
            snapshot.set(addr, state.twabWeight);
        }
        snapshots.set(checkpointTs, snapshot);
        checkpointIndex++;
    }

    if (!snapshots.has(endTimestamp)) {
        advanceTime(endTimestamp);
        syncAllHolders();
        const snapshot = new Map<Address, bigint>();
        for (const [addr, state] of holders.entries()) {
            snapshot.set(addr, state.twabWeight);
        }
        snapshots.set(endTimestamp, snapshot);
    }

    if (!snapshots.has(startTimestamp)) {
        const snapshot = new Map<Address, bigint>();
        for (const [addr, state] of holders.entries()) {
            snapshot.set(addr, state.twabWeight);
        }
        snapshots.set(startTimestamp, snapshot);
    }

    return snapshots;
};
