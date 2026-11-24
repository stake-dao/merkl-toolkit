export interface DistributionData {
    timestamp: number;
    blockNumber: number;
    sentOnchain: boolean; // The toolkit finished writing the Merkle for this round.
    firmRecovery?: {
        stage: "withdraw" | "credit" | "restore";
        sourceTimestamp: number;
        sourceRoot: string;
    };
}
