export type EarnedSource = "direct" | "morpho" | "firm";
export type ProductType = EarnedSource | "both";

export interface VaultTokenBreakdown {
    earned: string;
    claimed: string;
    claimable: string;
    type: ProductType;
    /** Sources for a mixed position that includes FiRM. */
    sources?: EarnedSource[];
}

export interface Breakdown {
    [userAddress: string]: {
        [vaultAddress: string]: {
            [tokenAddress: string]: VaultTokenBreakdown;
        };
    };
}

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
