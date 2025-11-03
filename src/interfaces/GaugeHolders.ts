import { Address } from "viem";
import { TokenHolder } from "./TokenHolder";

export interface GaugeWindowSnapshot {
    incentiveId: number;
    startTimestamp: number;
    endTimestamp: number;
    holders: TokenHolder[];
}

export interface GaugeHolders {
    vault: Address;
    windows: GaugeWindowSnapshot[];
}
