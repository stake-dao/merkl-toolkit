import { Address, getAddress } from "viem";
import axios from "axios";
import fs from "fs";
import path from "path";

import { WrapperIntegration, WrapperContext } from "../types";
import { TransferLog, DEFAULT_LOG_CHUNK_SIZE } from "../../utils/chain";
import { safeParse, safeStringify } from "../../utils/parse";
import { morphoAbi, erc20Abi, depositedEvent, withdrawnEvent, liquidatedEvent } from "./abi";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address;
const LENDING_API = "https://api-lending.stakedao.org/v1/graphql";

/**
 * Cached depositor set per wrapper address.
 * Same pattern as data/holders/{vault}/index.json.
 */
interface DepositorCache {
    blockNumber: number;
    users: Address[];
}

const getCacheDir = (wrapper: string): string =>
    path.resolve(__dirname, `../../../data/holders/morpho/${wrapper}`);

const getCachePath = (wrapper: string): string =>
    path.resolve(getCacheDir(wrapper), "index.json");

const readDepositorCache = (wrapper: string): DepositorCache => {
    const dir = getCacheDir(wrapper);
    if (!fs.existsSync(dir)) return { blockNumber: 0, users: [] };
    const filePath = getCachePath(wrapper);
    if (!fs.existsSync(filePath)) return { blockNumber: 0, users: [] };
    return safeParse(fs.readFileSync(filePath, { encoding: "utf-8" })) as DepositorCache;
};

const writeDepositorCache = (wrapper: string, data: DepositorCache): void => {
    const dir = getCacheDir(wrapper);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getCachePath(wrapper), safeStringify(data), { encoding: "utf-8" });
};

export interface MorphoWrapperContext extends WrapperContext {
    marketId: `0x${string}`;
}

/**
 * Morpho lending integration.
 *
 * MorphoStrategyWrapper contracts are used as collateral in Morpho markets.
 * This integration drills down into wrapper positions so each depositor
 * earns rewards proportional to their collateral TWAB.
 *
 * Uses the wrapper's own events (Deposited, Withdrawn, Liquidated) as the
 * single source of truth. This mirrors the wrapper's internal accounting —
 * a liquidated user keeps earning until claimLiquidation is called, which
 * is consistent with how the wrapper distributes main + extra rewards.
 *
 * Depositor discovery is cached incrementally in
 * data/holders/morpho/{wrapper}/index.json to avoid rescanning from genesis.
 */
export class MorphoIntegration implements WrapperIntegration {
    readonly name = "morpho-lending";
    private client: any;
    private wrappersCache: Map<Address, WrapperContext> | null = null;

    constructor(client: any) {
        this.client = client;
    }

    /**
     * Fetch the list of Morpho markets from the lending API.
     * This is structural data (which wrappers exist) — not position data.
     */
    async getWrappers(): Promise<Map<Address, WrapperContext>> {
        if (this.wrappersCache) return this.wrappersCache;

        let data: any;
        try {
            const response = await axios.post(LENDING_API, {
                query: `{ Market { collateralToken marketId } }`,
            });
            data = response.data;
        } catch (error) {
            console.error('❌ Failed to fetch Morpho markets from lending API');
            process.exit(1);
        }

        const map = new Map<Address, WrapperContext>();
        for (const market of data.data.Market) {
            const wrapper = getAddress(market.collateralToken) as Address;
            map.set(wrapper, {
                wrapper,
                marketId: market.marketId as `0x${string}`,
            });
        }

        this.wrappersCache = map;
        return map;
    }

    /**
     * Discover all depositors that ever interacted with this wrapper,
     * using incremental on-chain event scanning with persistent cache.
     */
    async getDepositors(
        ctx: WrapperContext,
        _fromBlock: bigint,
        toBlock: bigint,
    ): Promise<Address[]> {
        const wrapper = ctx.wrapper;

        const cache = readDepositorCache(wrapper);
        const scanFrom = cache.blockNumber > 0 ? BigInt(cache.blockNumber) + 1n : 0n;

        if (scanFrom > toBlock) {
            return cache.users;
        }

        console.log(`    📡 Scanning wrapper events for ${wrapper} from block ${scanFrom} to ${toBlock}`);

        const newUsers = await this.scanUsersFromEvents(wrapper, scanFrom, toBlock);
        const allUsers = Array.from(new Set([...cache.users, ...newUsers]))
            .filter((u) => u.toLowerCase() !== ZERO_ADDRESS.toLowerCase());

        writeDepositorCache(wrapper, {
            blockNumber: Number(toBlock),
            users: allUsers,
        });

        console.log(`    ✅ ${allUsers.length} total depositors (${newUsers.length} new)`);
        return allUsers;
    }

    /**
     * Fetch each depositor's collateral balance at `blockNumber` via Morpho's position view.
     */
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
                } else {
                    console.error(`❌ Multicall position() failed for user ${batch[j]} in wrapper ${ctx.wrapper}`);
                    process.exit(1);
                }
            }
        }

        return balances;
    }

    /**
     * Total wrapper tokens held as collateral in Morpho at `blockNumber`.
     */
    async getTotalSupply(
        ctx: WrapperContext,
        blockNumber: bigint,
    ): Promise<bigint> {
        return await this.client.readContract({
            address: ctx.wrapper,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [MORPHO_ADDRESS],
            blockNumber,
        });
    }

    /**
     * Fetch wrapper events (Deposited, Withdrawn, Liquidated) and convert
     * to synthetic TransferLog entries.
     *
     * Mapping:
     *   Deposited(caller, receiver, amount, marketId) → { from: 0x0, to: receiver, value: amount }
     *   Withdrawn(user, amount)                       → { from: user, to: 0x0, value: amount }
     *   Liquidated(liquidator, victim, amount)         → { from: victim, to: 0x0, value: amount }
     */
    async getTransferLogs(
        ctx: WrapperContext,
        fromBlock: bigint,
        toBlock: bigint,
    ): Promise<TransferLog[]> {
        const wrapper = ctx.wrapper;
        const logs: TransferLog[] = [];
        const chunkSize = DEFAULT_LOG_CHUNK_SIZE;

        for (let start = fromBlock; start <= toBlock; start += chunkSize) {
            const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;

            // Deposited — mint-like: 0x0 → receiver
            const depositLogs = await this.client.getLogs({
                address: wrapper,
                event: depositedEvent,
                fromBlock: start,
                toBlock: end,
            });
            for (const log of depositLogs) {
                logs.push({
                    blockNumber: log.blockNumber!,
                    logIndex: Number(log.logIndex ?? 0),
                    from: ZERO_ADDRESS,
                    to: log.args.receiver as Address,
                    value: BigInt(log.args.amount!),
                });
            }

            // Withdrawn — burn-like: user → 0x0
            const withdrawLogs = await this.client.getLogs({
                address: wrapper,
                event: withdrawnEvent,
                fromBlock: start,
                toBlock: end,
            });
            for (const log of withdrawLogs) {
                logs.push({
                    blockNumber: log.blockNumber!,
                    logIndex: Number(log.logIndex ?? 0),
                    from: log.args.user as Address,
                    to: ZERO_ADDRESS,
                    value: BigInt(log.args.amount!),
                });
            }

            // Liquidated — burn-like: victim → 0x0
            // Fires when claimLiquidation is called, matching the wrapper's
            // internal accounting (victim earns until claim).
            const liquidationLogs = await this.client.getLogs({
                address: wrapper,
                event: liquidatedEvent,
                fromBlock: start,
                toBlock: end,
            });
            for (const log of liquidationLogs) {
                logs.push({
                    blockNumber: log.blockNumber!,
                    logIndex: Number(log.logIndex ?? 0),
                    from: log.args.victim as Address,
                    to: ZERO_ADDRESS,
                    value: BigInt(log.args.amount!),
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
     * Scan wrapper events to discover all addresses that ever deposited,
     * withdrew, or were liquidated in the given block range.
     */
    private async scanUsersFromEvents(
        wrapper: Address,
        fromBlock: bigint,
        toBlock: bigint,
    ): Promise<Address[]> {
        const users = new Set<Address>();
        const chunkSize = DEFAULT_LOG_CHUNK_SIZE;

        for (let start = fromBlock; start <= toBlock; start += chunkSize) {
            const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;

            const [deposits, withdrawals, liquidations] = await Promise.all([
                this.client.getLogs({
                    address: wrapper,
                    event: depositedEvent,
                    fromBlock: start,
                    toBlock: end,
                }),
                this.client.getLogs({
                    address: wrapper,
                    event: withdrawnEvent,
                    fromBlock: start,
                    toBlock: end,
                }),
                this.client.getLogs({
                    address: wrapper,
                    event: liquidatedEvent,
                    fromBlock: start,
                    toBlock: end,
                }),
            ]);

            for (const log of deposits) users.add(getAddress(log.args.receiver) as Address);
            for (const log of withdrawals) users.add(getAddress(log.args.user) as Address);
            for (const log of liquidations) {
                users.add(getAddress(log.args.liquidator) as Address);
                users.add(getAddress(log.args.victim) as Address);
            }
        }

        return Array.from(users);
    }
}
