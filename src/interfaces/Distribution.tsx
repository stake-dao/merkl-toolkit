import { Address } from "viem";

export interface Distribution {
    timestamp: number;
    blockNumber: number;
    incentives: IncentiveDistribution[];
}

export interface IncentiveDistribution {
    vault: Address;
    token: IntentiveToken;
    users: UserDistribution[];
}

export interface IntentiveToken {
    address: Address;
    decimals: number;
    symbol: string;
}

export interface UserDistribution {
    user: Address;
    balance: string;
    share: string;
    amount: string;
}