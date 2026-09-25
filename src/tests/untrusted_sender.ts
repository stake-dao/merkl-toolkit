import assert from "assert";
import { isTrustedIncentive } from "../utils/merkl";

const HOOK_V1 = "0x06Ab7052b00d038F8EeF33B267C23b5154cE8cDc";
const HOOK_V2 = "0x68654D460fDF3231B49B25817cBBD72d8d291Fcf";
const STRANGER = "0x000000000000000000000000000000000000bEEF";
const ARBITRUM = BigInt(42161);
const MAINNET = BigInt(1);

// Mainnet incentives pull their tokens on-chain, so any sender is fine.
assert.equal(isTrustedIncentive(MAINNET, STRANGER), true);

// Bridged incentives are only trusted from our VoteMarket hooks.
assert.equal(isTrustedIncentive(ARBITRUM, HOOK_V1), true);
assert.equal(isTrustedIncentive(ARBITRUM, HOOK_V2.toLowerCase()), true);
assert.equal(isTrustedIncentive(ARBITRUM, STRANGER), false);
assert.equal(isTrustedIncentive(ARBITRUM, "not-an-address"), false);

console.log("✅ untrusted_sender: all assertions passed");
