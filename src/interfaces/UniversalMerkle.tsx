export interface UniversalMerkle {
    [address: string]: {
        [tokenAddress: string]: string
    }
}