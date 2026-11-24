export interface DistributionData {
    timestamp: number;
    blockNumber: number;
    sentOnchain: boolean; // The toolkit finished writing the Merkle for this round.
    firmRecovery?: {
        sourceRoot: string;
    };
}
