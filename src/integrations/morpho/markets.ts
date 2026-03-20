import { Address } from "viem";
import { MorphoWrapperContext } from "./index";

/**
 * Static mapping of MorphoStrategyWrapper addresses to their Morpho market IDs.
 *
 * To add a new market, add an entry here with:
 *   - key: the wrapper contract address (collateral token in Morpho)
 *   - value: { wrapper, marketId }
 *
 * Find these values from the Morpho UI or by querying the Morpho contract.
 */
export const MORPHO_MARKETS: Map<Address, MorphoWrapperContext> = new Map([
    // Example:
    // ["0xWrapperAddress" as Address, {
    //     wrapper: "0xWrapperAddress" as Address,
    //     marketId: "0xMarketIdBytes32..." as `0x${string}`,
    // }],
]);
