import { Address } from "viem";
import { TransferLog } from "../utils/chain";

/**
 * A WrapperIntegration "drills down" into a wrapper contract that holds
 * vault shares on behalf of multiple depositors.
 *
 * Each integration (Morpho lending, Beefy vaults, etc.) implements this
 * interface so the distribution pipeline can redistribute the wrapper's
 * allocation among its actual depositors using full TWAB precision.
 */
export interface WrapperIntegration {
    /** Human-readable name for logging (e.g. "morpho-lending", "beefy"). */
    readonly name: string;

    /**
     * Return the set of wrapper addresses this integration manages.
     * Called once at the start of a distribution run.
     * The returned map keys are wrapper addresses (lowercase); values are
     * opaque context needed by the other methods (e.g. a marketId for Morpho).
     */
    getWrappers(): Promise<Map<Address, WrapperContext>>;

    /**
     * Discover all depositors that held positions during the given block range.
     * Must include historical depositors who withdrew mid-window.
     */
    getDepositors(
        ctx: WrapperContext,
        fromBlock: bigint,
        toBlock: bigint,
    ): Promise<Address[]>;

    /**
     * Fetch each depositor's balance at `blockNumber`.
     * Equivalent to a multicall of the integration-specific position query.
     */
    getBalancesAtBlock(
        ctx: WrapperContext,
        users: Address[],
        blockNumber: bigint,
    ): Promise<Map<Address, bigint>>;

    /**
     * Fetch integration-specific events in [fromBlock, toBlock] and convert
     * them to synthetic TransferLog entries consumable by computeTwabSnapshots.
     */
    getTransferLogs(
        ctx: WrapperContext,
        fromBlock: bigint,
        toBlock: bigint,
    ): Promise<TransferLog[]>;

    /**
     * Return the expected total of all depositor balances at `blockNumber`.
     * Used to verify that all depositors were discovered.
     */
    getTotalSupply(
        ctx: WrapperContext,
        blockNumber: bigint,
    ): Promise<bigint>;
}

/**
 * Opaque per-wrapper context. Each integration defines its own shape
 * and casts internally.
 */
export interface WrapperContext {
    /** The wrapper contract address. */
    wrapper: Address;
    /** Integration-specific payload (marketId, vaultId, etc.). */
    [key: string]: unknown;
}
