import { parseAbi } from "viem";

export const merklAbi = parseAbi([
    'function nbIncentives() external view returns(uint256)',
    'function incentives(uint256 i) external view returns (address gauge, address reward, uint256 duration, uint256 start, uint256 end, uint256 fromChainId, address sender, uint256 amount, address manager)',

])