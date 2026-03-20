import { Address, getAddress } from "viem";
import axios from "axios";

import { WrapperIntegration, WrapperContext } from "../types";
import { TransferLog, DEFAULT_LOG_CHUNK_SIZE } from "../../utils/chain";
import { morphoAbi, supplyCollateralEvent, withdrawCollateralEvent, liquidateEvent } from "./abi";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address;
const LENDING_API = "https://api-lending.stakedao.org/v1/graphql";

export interface MorphoWrapperContext extends WrapperContext {
    marketId: `0x${string}`;
}

/**
 * Morpho lending integration.
 *
 * MorphoStrategyWrapper contracts are used as collateral in Morpho markets.
 * This integration drills down into Morpho positions so each depositor
 * earns rewards proportional to their collateral TWAB.
 */
export class MorphoIntegration implements WrapperIntegration {
    readonly name = "morpho-lending";
    private client: any;
    private wrappersCache: Map<Address, WrapperContext> | null = null;

    constructor(client: any) {
        this.client = client;
    }

    async getWrappers(): Promise<Map<Address, WrapperContext>> {
        if (this.wrappersCache) return this.wrappersCache;

        const { data } = await axios.post(LENDING_API, {
            query: `{ Market { collateralToken marketId } }`,
        });

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

    async getDepositors(
        ctx: WrapperContext,
        _fromBlock: bigint,
        _toBlock: bigint,
    ): Promise<Address[]> {
        const { marketId } = ctx as MorphoWrapperContext;

        // Current depositors from the lending API
        const { data } = await axios.post(LENDING_API, {
            query: `query ($id: String!) {
                Position(where: { marketId: { _eq: $id }, collateral: { _gt: "0" } }) {
                    user
                }
            }`,
            variables: { id: marketId },
        });

        const apiUsers = new Set<Address>(
            data.data.Position.map((p: { user: string }) => getAddress(p.user) as Address),
        );

        // Supplement with historical depositors from on-chain events
        const eventUsers = await this.discoverUsersFromEvents(marketId, _fromBlock, _toBlock);
        for (const addr of eventUsers) {
            apiUsers.add(addr);
        }

        return Array.from(apiUsers);
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
     * Scan Morpho events to discover addresses that interacted during the window.
     * Catches depositors who withdrew before the current API snapshot.
     */
    private async discoverUsersFromEvents(
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
