import { Address, getAddress } from "viem";
import fs from "fs";
import path from "path";

import { WrapperIntegration, WrapperContext } from "../types";
import { TransferLog, DEFAULT_LOG_CHUNK_SIZE } from "../../utils/chain";
import { safeParse, safeStringify } from "../../utils/parse";
import { morphoAbi, supplyCollateralEvent, withdrawCollateralEvent, liquidateEvent } from "./abi";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address;

/**
 * Cached depositor set per marketId.
 * Same pattern as data/holders/{vault}/index.json.
 */
interface DepositorCache {
    blockNumber: number;
    users: Address[];
}

const getCacheDir = (marketId: string): string =>
    path.resolve(__dirname, `../../../data/holders/morpho/${marketId}`);

const getCachePath = (marketId: string): string =>
    path.resolve(getCacheDir(marketId), "index.json");

const readDepositorCache = (marketId: string): DepositorCache => {
    const dir = getCacheDir(marketId);
    if (!fs.existsSync(dir)) return { blockNumber: 0, users: [] };
    const filePath = getCachePath(marketId);
    if (!fs.existsSync(filePath)) return { blockNumber: 0, users: [] };
    return safeParse(fs.readFileSync(filePath, { encoding: "utf-8" })) as DepositorCache;
};

const writeDepositorCache = (marketId: string, data: DepositorCache): void => {
    const dir = getCacheDir(marketId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getCachePath(marketId), safeStringify(data), { encoding: "utf-8" });
};

export interface MorphoWrapperContext extends WrapperContext {
    marketId: `0x${string}`;
}

/**
 * Morpho lending integration.
 *
 * MorphoStrategyWrapper contracts are used as collateral in Morpho markets.
 * This integration drills down into Morpho positions so each depositor
 * earns rewards proportional to their collateral TWAB.
 *
 * Depositor discovery is done exclusively via on-chain events (SupplyCollateral,
 * WithdrawCollateral, Liquidate). Results are cached incrementally in
 * data/holders/morpho/{marketId}/index.json to avoid rescanning from genesis.
 */
export class MorphoIntegration implements WrapperIntegration {
    readonly name = "morpho-lending";
    private client: any;
    private wrapperEntries: Map<Address, WrapperContext>;

    /**
     * @param client - viem public client
     * @param wrapperEntries - map of wrapper address → MorphoWrapperContext.
     *   Must be provided at construction — these are the known Morpho markets.
     */
    constructor(client: any, wrapperEntries: Map<Address, MorphoWrapperContext>) {
        this.client = client;
        this.wrapperEntries = wrapperEntries;
    }

    async getWrappers(): Promise<Map<Address, WrapperContext>> {
        return this.wrapperEntries;
    }

    /**
     * Discover all depositors that ever interacted with this market,
     * using incremental on-chain event scanning with persistent cache.
     */
    async getDepositors(
        ctx: WrapperContext,
        _fromBlock: bigint,
        toBlock: bigint,
    ): Promise<Address[]> {
        const { marketId } = ctx as MorphoWrapperContext;

        const cache = readDepositorCache(marketId);
        const scanFrom = cache.blockNumber > 0 ? BigInt(cache.blockNumber) + 1n : 0n;

        if (scanFrom > toBlock) {
            return cache.users;
        }

        console.log(`    📡 Scanning Morpho events for market ${marketId} from block ${scanFrom} to ${toBlock}`);

        const newUsers = await this.scanUsersFromEvents(marketId, scanFrom, toBlock);
        const allUsers = Array.from(new Set([...cache.users, ...newUsers]))
            .filter((u) => u.toLowerCase() !== ZERO_ADDRESS.toLowerCase());

        writeDepositorCache(marketId, {
            blockNumber: Number(toBlock),
            users: allUsers,
        });

        console.log(`    ✅ ${allUsers.length} total depositors (${newUsers.length} new)`);
        return allUsers;
    }

    async getBalancesAtBlock(
        ctx: WrapperContext,
        users: Address[],
        blockNumber: bigint,
    ): Promise<Map<Address, bigint>> {
        const { marketId } = ctx as MorphoWrapperContext;
        const balances = new Map<Address, bigint>();

        const batchSize = 100;
        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);
            const contracts = batch.map((user) => ({
                address: MORPHO_ADDRESS,
                abi: morphoAbi,
                functionName: "position" as const,
                args: [marketId, user] as const,
            }));

            const results = await this.client.multicall({ contracts, blockNumber });

            for (let j = 0; j < batch.length; j++) {
                const result = results[j];
                if (result.status === "success") {
                    const collateral = BigInt(result.result[2]);
                    if (collateral > 0n) {
                        balances.set(batch[j], collateral);
                    }
                }
            }
        }

        return balances;
    }

    async getTransferLogs(
        ctx: WrapperContext,
        fromBlock: bigint,
        toBlock: bigint,
    ): Promise<TransferLog[]> {
        const { marketId } = ctx as MorphoWrapperContext;
        const logs: TransferLog[] = [];
        const chunkSize = DEFAULT_LOG_CHUNK_SIZE;

        for (let start = fromBlock; start <= toBlock; start += chunkSize) {
            const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;

            // SupplyCollateral — mint-like: 0x0 → onBehalf
            const supplyLogs = await this.client.getLogs({
                address: MORPHO_ADDRESS,
                event: supplyCollateralEvent,
                args: { id: marketId },
                fromBlock: start,
                toBlock: end,
            });
            for (const log of supplyLogs) {
                logs.push({
                    blockNumber: log.blockNumber!,
                    logIndex: Number(log.logIndex ?? 0),
                    from: ZERO_ADDRESS,
                    to: log.args.onBehalf as Address,
                    value: BigInt(log.args.assets!),
                });
            }

            // WithdrawCollateral — burn-like: onBehalf → 0x0
            const withdrawLogs = await this.client.getLogs({
                address: MORPHO_ADDRESS,
                event: withdrawCollateralEvent,
                args: { id: marketId },
                fromBlock: start,
                toBlock: end,
            });
            for (const log of withdrawLogs) {
                logs.push({
                    blockNumber: log.blockNumber!,
                    logIndex: Number(log.logIndex ?? 0),
                    from: log.args.onBehalf as Address,
                    to: ZERO_ADDRESS,
                    value: BigInt(log.args.assets!),
                });
            }

            // Liquidate — burn-like: borrower → 0x0 (seizedAssets)
            const liquidateLogs = await this.client.getLogs({
                address: MORPHO_ADDRESS,
                event: liquidateEvent,
                args: { id: marketId },
                fromBlock: start,
                toBlock: end,
            });
            for (const log of liquidateLogs) {
                logs.push({
                    blockNumber: log.blockNumber!,
                    logIndex: Number(log.logIndex ?? 0),
                    from: log.args.borrower as Address,
                    to: ZERO_ADDRESS,
                    value: BigInt(log.args.seizedAssets!),
                });
            }
        }

        logs.sort((a, b) =>
            a.blockNumber === b.blockNumber
                ? a.logIndex - b.logIndex
                : a.blockNumber < b.blockNumber ? -1 : 1,
        );

        return logs;
    }

    /**
     * Scan Morpho events to discover all addresses that ever interacted
     * with this market in the given block range.
     */
    private async scanUsersFromEvents(
        marketId: `0x${string}`,
        fromBlock: bigint,
        toBlock: bigint,
    ): Promise<Address[]> {
        const users = new Set<Address>();
        const chunkSize = DEFAULT_LOG_CHUNK_SIZE;

        for (let start = fromBlock; start <= toBlock; start += chunkSize) {
            const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;

            const [supplies, withdrawals, liquidations] = await Promise.all([
                this.client.getLogs({
                    address: MORPHO_ADDRESS,
                    event: supplyCollateralEvent,
                    args: { id: marketId },
                    fromBlock: start,
                    toBlock: end,
                }),
                this.client.getLogs({
                    address: MORPHO_ADDRESS,
                    event: withdrawCollateralEvent,
                    args: { id: marketId },
                    fromBlock: start,
                    toBlock: end,
                }),
                this.client.getLogs({
                    address: MORPHO_ADDRESS,
                    event: liquidateEvent,
                    args: { id: marketId },
                    fromBlock: start,
                    toBlock: end,
                }),
            ]);

            for (const log of supplies) users.add(getAddress(log.args.onBehalf) as Address);
            for (const log of withdrawals) users.add(getAddress(log.args.onBehalf) as Address);
            for (const log of liquidations) users.add(getAddress(log.args.borrower) as Address);
        }

        return Array.from(users);
    }
}
