import { Incentive } from "./Incentive";

export interface IncentiveExtended extends Incentive {
    rewardDecimals: number;
    rewardSymbol: string;
    vault: string;
}