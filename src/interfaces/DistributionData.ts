export interface DistributionData {
    timestamp: number;
    blockNumber: number;
    sentOnchain: boolean; // The toolkit finished writing the Merkle for this round.
    pmusdRecovery?: true;
    firmRecovery?: {
        sourceRoot: string;
    };
}
