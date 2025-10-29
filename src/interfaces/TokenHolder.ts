import { Address } from "viem";

export interface TokenHolder {
    user: Address;
    weight: string;
    sharePercentage: string;
}
