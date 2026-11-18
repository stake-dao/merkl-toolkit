
export interface MerkleData {
    merkleRoot: string;
    parentRoot?: string;
    firstDistribution?: number;
    claims: {
        [address: string]: AddressClaim;
    };
}

export interface AddressClaim {
    tokens: {
        [tokenAddress: string]: TokenClaim;
    };
}

export interface TokenClaim {
    amount: string;
    proof: string[];
}
