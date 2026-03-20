import { parseAbi, parseAbiItem } from "viem";

export const morphoAbi = parseAbi([
    "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);

// StrategyWrapper events
export const depositedEvent = parseAbiItem(
    "event Deposited(address indexed caller, address indexed receiver, uint256 amount, bytes32 marketId)",
);

export const withdrawnEvent = parseAbiItem(
    "event Withdrawn(address indexed user, uint256 amount)",
);

export const liquidatedEvent = parseAbiItem(
    "event Liquidated(address indexed liquidator, address indexed victim, uint256 amount)",
);
