export type ProductType = "direct" | "morpho" | "both";

export interface VaultTokenBreakdown {
    earned: string;
    claimed: string;
    claimable: string;
    type: ProductType;
}

export interface Breakdown {
    [userAddress: string]: {
        [vaultAddress: string]: {
            [tokenAddress: string]: VaultTokenBreakdown;
        };
    };
}

export type EarnedSource = "direct" | "morpho";

export interface SerializedEarnedEntry {
    timestamp: number;
    vault: string;
    amount: bigint;
    source: EarnedSource;
}

export interface SerializedClaimEvent {
    blockNumber: bigint;
    timestamp: number;
    user: string;
    amount: bigint;
}

export interface BreakdownMeta {
    lastProcessedTimestamp: number;
    lastScannedBlock: number;
}
