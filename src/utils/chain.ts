import { Address, parseAbiItem } from "viem";

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export const DEFAULT_LOG_CHUNK_SIZE = 20_000n;

export type BlockTimestampCache = Map<string, number>;

export interface TransferLog {
    blockNumber: bigint;
    logIndex: number;
    from: Address;
    to: Address;
    value: bigint;
}

const toCacheKey = (block: bigint): string => block.toString();

export const fetchTransferLogs = async (
    client: any,
    token: Address,
    fromBlock: bigint,
    toBlock: bigint,
    chunkSize: bigint = DEFAULT_LOG_CHUNK_SIZE,
): Promise<TransferLog[]> => {
    const logs: TransferLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
        const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
        const chunk = await client.getLogs({
            address: token,
            event: TRANSFER_EVENT,
            fromBlock: start,
            toBlock: end,
        });
        for (const log of chunk) {
            logs.push({
                blockNumber: log.blockNumber!,
                logIndex: Number(log.logIndex ?? 0n),
                from: log.args?.from as Address,
                to: log.args?.to as Address,
                value: BigInt(log.args?.value ?? 0n),
            });
        }
    }
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    return logs;
};

export const getBlockTimestamp = async (
    client: any,
    blockNumber: bigint,
    cache: BlockTimestampCache,
): Promise<number> => {
    const key = toCacheKey(blockNumber);
    if (cache.has(key)) return cache.get(key)!;
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
    let low = lowerBound;
    let high = upperBound;
    while (low < high) {
        const mid = (low + high) / 2n;
        const midTs = await getBlockTimestamp(client, mid, cache);
        if (midTs < targetTimestamp) low = mid + 1n;
        else high = mid;
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
    let low = lowerBound;
    let high = upperBound;
    while (low < high) {
        const mid = (low + high + 1n) / 2n;
        const midTs = await getBlockTimestamp(client, mid, cache);
        if (midTs > targetTimestamp) high = mid - 1n;
        else low = mid;
    }
    return low;
};

