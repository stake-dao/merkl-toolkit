import { Address } from "viem";
import { TokenHolder } from "./TokenHolder";

export interface GaugeHolders {
    vault: Address;
    holders: TokenHolder[];
}