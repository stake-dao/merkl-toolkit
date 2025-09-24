export interface Strategy {
    key: string;
    name: string;
    tokensFilter: string[];
    protocol: string;
    chainId: number;
    vault: string;

    lpToken: {
        name: string;
        symbol: string;
        address: string;
        decimals: number;
    };

    gaugeAddress: string;

    coins: {
        name: string;
        symbol: string;
        address: string;
        decimals: number;
    }[];

    sdGauge: {
        address: string;
        totalSupply: string;
        relativeWeight: string;
        weight: string;
        futureWeight: string;
        workingSupply: string;
    };

    lpPriceInUsd: number;
    streaming: boolean;
    tvl: number;

    apr: {
        boost: number;
        current: {
            total: number;
            details: {
                label: string;
                value: number[];
            }[];
        };
        projected: {
            total: number;
            details: {
                label: string;
                value: number[];
            }[];
        };
    };

    sdtApr: {
        sdtUserApr: number;
        sdtFuturUserApr: number;
        sdtMinApr: number;
        sdtFuturMinApr: number;
        sdtMaxApr: number;
        sdtFuturMaxApr: number;
        sdtBoost: number;
    };

    rewards: {
        token: {
            name: string;
            symbol: string;
            address: string;
            decimals: number;
        };
        price: number;
        apr: number;
        streaming: boolean;
        periodFinish: number;
        rate: string;
        lastUpdate: string;
        claimablePendingRewards: string;
    }[];

    tradingApy: number;
    minApr: number;
    maxApr: number;

    vaultHoldings: string;
    totalSupply: string;
    strategyHoldings: string;
    workingBalance: string;

    vaultFees: {
        keeper: number;
        accumulated: string;
    };
}