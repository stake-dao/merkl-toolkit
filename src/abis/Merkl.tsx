import { parseAbi } from "viem";

export const merklAbi = parseAbi([
    'function nbIncentives() external view returns(uint256)',
    'function incentives(uint256 i) external view returns(Incentive memory)',
])