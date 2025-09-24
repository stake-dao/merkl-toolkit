
export interface MerkleData {
    merkleRoot: string;
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
