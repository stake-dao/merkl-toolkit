import { parseAbi, parseAbiItem } from "viem";

export const morphoAbi = parseAbi([
    "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);

export const supplyCollateralEvent = parseAbiItem(
    "event SupplyCollateral(bytes32 indexed id, address caller, address indexed onBehalf, uint256 assets)",
);

export const withdrawCollateralEvent = parseAbiItem(
    "event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)",
);

export const liquidateEvent = parseAbiItem(
    "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
);
