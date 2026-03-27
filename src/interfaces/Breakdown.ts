export interface VaultTokenBreakdown {
    earned: string;
    claimed: string;
    claimable: string;
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
}

export interface SerializedClaimEvent {
    blockNumber: bigint;
    timestamp: number;
    user: string;
    amount: bigint;
}

export interface BreakdownFile {
    lastProcessedTimestamp: number;
    lastScannedBlock: number;
    earnedEntries: Record<string, SerializedEarnedEntry[]>;
    claimEvents: Record<string, SerializedClaimEvent[]>;
    breakdown: Breakdown;
}
