import { Address } from "viem";

export interface TokenHolder {
    user: Address;
    balance: string;
}