import { Incentive } from "./Incentive";

export interface IncentiveExtended extends Incentive {
    id: number;
    rewardDecimals: number;
    rewardSymbol: string;
    vault: string;
    ended: boolean;
    distributedUntil: bigint;
}
