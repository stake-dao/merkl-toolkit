import fs from "fs";
import path from "path";
import {
    Address,
    getAddress,
    Hex,
    encodeFunctionData,
    decodeFunctionResult,
    formatUnits,
    erc20Abi,
    pad,
} from "viem";
import { mainnet } from "viem/chains";
import { getClient } from "../utils/rpc";
import { MERKL_CONTRACT } from "../constants";
import { merklAbi } from "../abis/Merkl";
import { safeParse } from "../utils/parse";
import { MerkleData } from "../interfaces/MerkleData";
import { Breakdown } from "../interfaces/Breakdown";
import * as dotenv from "dotenv";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "../data");

interface TestCase {
    user: Address;
    token: Address;
    expectedDelta: bigint;
    merkleAmount: bigint;
    proof: Hex[];
}

export const testBreakdown = async () => {
    console.log("🧪 Starting breakdown validation...\n");

    // 1. Load breakdown and merkle
    const breakdown = safeParse(
        fs.readFileSync(path.resolve(DATA_DIR, "breakdown", "breakdown.json"), { encoding: "utf-8" }),
    ) as Breakdown;

    const merkle = safeParse(
        fs.readFileSync(path.resolve(DATA_DIR, "last_merkle.json"), { encoding: "utf-8" }),
    ) as MerkleData;

    // 2. Build test cases: for each (user, token), sum claimable across vaults
    const testCases: TestCase[] = [];
    const distinctTokens = new Set<Address>();

    for (const [user, vaults] of Object.entries(breakdown)) {
        const tokenClaimable = new Map<string, bigint>();

        for (const tokens of Object.values(vaults)) {
            for (const [token, data] of Object.entries(tokens)) {
                const claimable = BigInt((data as any).claimable);
                if (claimable > 0n) {
                    tokenClaimable.set(token, (tokenClaimable.get(token) ?? 0n) + claimable);
                }
            }
        }

        for (const [token, expectedDelta] of tokenClaimable.entries()) {
            const userAddr = getAddress(user) as Address;
            const tokenAddr = getAddress(token) as Address;
            distinctTokens.add(tokenAddr);

            // Get merkle proof
            const userClaim = merkle.claims[userAddr] ?? merkle.claims[user];
            if (!userClaim) {
                console.error(`❌ User ${user} not found in merkle`);
                continue;
            }

            const tokenClaim = userClaim.tokens[tokenAddr] ?? userClaim.tokens[token];
            if (!tokenClaim) {
                console.error(`❌ Token ${token} not found in merkle for user ${user}`);
                continue;
            }

            testCases.push({
                user: userAddr,
                token: tokenAddr,
                expectedDelta,
                merkleAmount: BigInt(tokenClaim.amount),
                proof: tokenClaim.proof as Hex[],
            });
        }
    }

    console.log(`📊 ${testCases.length} test cases (users with claimable > 0)`);
    console.log(`🪙  ${distinctTokens.size} distinct token(s)\n`);

    if (testCases.length === 0) {
        console.log("✅ Nothing to test — no claimable amounts");
        return;
    }

    // 3. Setup client and check root
    const client = await getClient(mainnet.id);

    const onChainRoot = await client.readContract({
        address: MERKL_CONTRACT,
        abi: merklAbi,
        functionName: "root",
    });

    const jsonRoot = merkle.merkleRoot as Hex;
    const needsOverride = onChainRoot !== jsonRoot;

    console.log(`🔍 Root check:`);
    console.log(`   JSON:     ${jsonRoot}`);
    console.log(`   On-chain: ${onChainRoot}`);
    if (needsOverride) {
        console.log(`   ⚠️  Mismatch — will use stateDiff override`);
    }
    console.log("");

    // 4. Fetch token decimals for display
    const tokenList = Array.from(distinctTokens);
    const decimalsResults = await client.multicall({
        contracts: tokenList.map((t) => ({
            address: t,
            abi: erc20Abi,
            functionName: "decimals" as const,
            args: [] as const,
        })),
    });
    const tokenDecimals: Record<Address, number> = {};
    for (let i = 0; i < tokenList.length; i++) {
        tokenDecimals[tokenList[i]] = decimalsResults[i].status === "success" ? Number(decimalsResults[i].result) : 18;
    }

    // 5. Fetch current claimed amounts for diagnostic
    const claimedResults = await client.multicall({
        contracts: testCases.map((tc) => ({
            address: MERKL_CONTRACT,
            abi: merklAbi,
            functionName: "claimed" as const,
            args: [tc.user, tc.token] as const,
        })),
    });

    // 6. Simulate each claim via eth_call and compare
    const slot0 = pad("0x0", { size: 32 });
    const stateOverride = needsOverride
        ? { [MERKL_CONTRACT]: { stateDiff: { [slot0]: jsonRoot } } }
        : undefined;

    let passCount = 0;
    let failCount = 0;
    let skipCount = 0;

    for (let idx = 0; idx < testCases.length; idx++) {
        const tc = testCases[idx];
        const calldata = encodeFunctionData({
            abi: merklAbi,
            functionName: "claim",
            args: [tc.user, tc.token, tc.merkleAmount, tc.proof],
        });

        try {
            const rawResult = await client.request({
                method: "eth_call",
                params: [
                    { to: MERKL_CONTRACT, from: tc.user, data: calldata },
                    "latest",
                    stateOverride as any,
                ],
            });

            const actualDelta = decodeFunctionResult({
                abi: merklAbi,
                functionName: "claim",
                data: rawResult,
            }) as bigint;

            const decimals = tokenDecimals[tc.token] ?? 18;

            if (actualDelta === tc.expectedDelta) {
                passCount++;
                console.log(
                    `✅ ${tc.user.slice(0, 8)}… | ${tc.token.slice(0, 8)}… | ` +
                    `${formatUnits(actualDelta, decimals)} claimed (matches breakdown)`,
                );
            } else {
                failCount++;
                const diff = actualDelta - tc.expectedDelta;

                // Diagnostic: show merkle amount, current claimed, and computed pending
                const claimedOnChain = claimedResults[idx]?.status === "success"
                    ? (claimedResults[idx].result as bigint)
                    : -1n;
                const computedPending = tc.merkleAmount - (claimedOnChain >= 0n ? claimedOnChain : 0n);

                console.error(
                    `❌ ${tc.user.slice(0, 8)}… | ${tc.token.slice(0, 8)}…\n` +
                    `   actual=${formatUnits(actualDelta, decimals)}  expected=${formatUnits(tc.expectedDelta, decimals)}  diff=${formatUnits(diff, decimals)}\n` +
                    `   merkle=${formatUnits(tc.merkleAmount, decimals)}  claimed=${claimedOnChain >= 0n ? formatUnits(claimedOnChain, decimals) : "ERR"}  pending=${formatUnits(computedPending, decimals)}`,
                );
            }
        } catch (error: any) {
            skipCount++;
            console.error(`⚠️  ${tc.user.slice(0, 8)}… | ${tc.token.slice(0, 8)}… | REVERT: ${error.message?.slice(0, 80)}`);
        }
    }

    // 6. Summary
    console.log("\n---------------------------------------------------");
    console.log(`🏁 Results:`);
    console.log(`   ✅ Pass:    ${passCount}`);
    console.log(`   ❌ Fail:    ${failCount}`);
    console.log(`   ⚠️  Revert:  ${skipCount}`);

    if (failCount > 0) {
        console.error(`\n🚨 FAILURE: ${failCount} claimable amount(s) don't match the breakdown.`);
        process.exit(1);
    } else {
        console.log(`\n✨ SUCCESS: All claimable amounts match the breakdown.`);
    }
};

if (require.main === module) {
    testBreakdown().catch((err) => {
        console.error("❌ Test failed:", err);
        process.exit(1);
    });
}
