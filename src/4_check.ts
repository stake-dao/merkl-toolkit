import {
    formatUnits,
    getAddress,
    Hex,
    encodeFunctionData,
    pad,
    decodeFunctionResult,
    erc20Abi,
    Address
} from 'viem';
import { mainnet } from 'viem/chains';
import { MERKL_CONTRACT } from './constants';
import { getClient } from './utils/rpc';
import fs from 'fs';
import { merklAbi } from './abis/Merkl';

export const check = async () => {
    console.log("🚀 Starting verification AND simulation script (RAW RPC mode)...");

    // 1. Load Merkle Data
    const MERKLE_DATA = JSON.parse(fs.readFileSync("./data/last_merkle.json", { encoding: 'utf-8' }));
    const NEW_ROOT = MERKLE_DATA.merkleRoot as Hex;

    // 2. Client Setup
    const client = await getClient(mainnet.id);

    // 3. Check On-Chain Root
    const onChainRoot = await client.readContract({
        address: MERKL_CONTRACT,
        abi: merklAbi,
        functionName: 'root',
    });

    console.log(`\n🔍 Root Check:`);
    console.log(`   JSON Root:     ${NEW_ROOT}`);
    console.log(`   Contract Root: ${onChainRoot}`);

    const needsOverride = onChainRoot !== NEW_ROOT;

    if (needsOverride) {
        console.log(`   🛠️  Mismatch detected. Simulating via RAW eth_call with stateDiff.`);
    }

    // 4. Flatten Data
    type ClaimData = { user: Hex, token: Hex, totalAmount: bigint, proof: Hex[] };
    const flatClaims: ClaimData[] = [];
    const claimsObj = (MERKLE_DATA as any).claims;
    const distinctTokens: Set<Address> = new Set();

    // Aggregators for Merkle totals
    const merkleTotals: Record<Address, bigint> = {};

    for (const [user, userDat] of Object.entries(claimsObj)) {
        const tokens = (userDat as any).tokens;
        for (const [token, tokenDat] of Object.entries(tokens)) {
            const tokenFormatted = getAddress(token as string);
            const amount = BigInt((tokenDat as any).amount);

            flatClaims.push({
                user: getAddress(user as string),
                token: tokenFormatted,
                totalAmount: amount,
                proof: (tokenDat as any).proof as Hex[]
            });

            distinctTokens.add(tokenFormatted);

            // Accumulate total defined in Merkle Tree
            merkleTotals[tokenFormatted] = (merkleTotals[tokenFormatted] || 0n) + amount;
        }
    }

    console.log(`\n📊 Analyzing & Simulating ${flatClaims.length} claims across ${distinctTokens.size} tokens...`);

    // 5. Fetch Data (Multicall)
    const tokenList = Array.from(distinctTokens);

    // 5a. Fetch 'claimed' amounts for every user
    const claimedResults = await client.multicall({
        contracts: flatClaims.map(c => ({
            address: MERKL_CONTRACT,
            abi: merklAbi,
            functionName: 'claimed',
            args: [c.user, c.token]
        }))
    });

    // 5b. Fetch Token Decimals
    const decimalsResults = await client.multicall({
        contracts: tokenList.map(t => ({
            address: t,
            abi: erc20Abi,
            functionName: 'decimals',
            args: []
        })),
    });

    // 5c. Fetch Contract Balances (To check solvency)
    const balanceResults = await client.multicall({
        contracts: tokenList.map(t => ({
            address: t,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [MERKL_CONTRACT]
        }))
    });

    // Process Token Info
    const tokenInfo: Record<Address, { decimals: number, balance: bigint }> = {};

    for (let i = 0; i < tokenList.length; i++) {
        const token = tokenList[i];
        const decimalRes = decimalsResults[i];
        const balanceRes = balanceResults[i];

        if (decimalRes.status !== 'success' || balanceRes.status !== 'success') {
            throw new Error(`Failed to fetch info for token ${token}`);
        }

        tokenInfo[token] = {
            decimals: Number(decimalRes.result),
            balance: balanceRes.result as bigint
        };
    }

    // --- NEW: GLOBAL SOLVENCY CHECK ---
    console.log(`\n💰 Global Solvency & Distribution Analysis:`);
    console.log("---------------------------------------------------");

    // Calculate global stats per token
    const tokenStats: Record<Address, { claimed: bigint, pending: bigint }> = {};

    for (let i = 0; i < flatClaims.length; i++) {
        const claim = flatClaims[i];
        const res = claimedResults[i];

        if (res.status === 'failure') throw new Error(`RPC Failure for ${claim.user}`);
        const alreadyClaimed = res.result as bigint;

        if (!tokenStats[claim.token]) {
            tokenStats[claim.token] = { claimed: 0n, pending: 0n };
        }

        // Integrity Check: New Amount >= Before
        if (claim.totalAmount < alreadyClaimed) {
            throw new Error(`🚨 CRITICAL: ${claim.user} JSON amount < OnChain claimed. Merkle regression detected!`);
        }

        const toDistribute = claim.totalAmount - alreadyClaimed;

        tokenStats[claim.token].claimed += alreadyClaimed;
        tokenStats[claim.token].pending += toDistribute;
    }

    // Display Stats
    for (const token of tokenList) {
        const decimals = tokenInfo[token].decimals;
        const stats = tokenStats[token];
        const totalMerkle = merkleTotals[token];
        const contractBalance = tokenInfo[token].balance;

        console.log(`Token: ${token}`);
        console.log(`   Total in Merkle:   ${formatUnits(totalMerkle, decimals)}`);
        console.log(`   Already Claimed:   ${formatUnits(stats.claimed, decimals)}`);
        console.log(`   Pending (Rewards): ${formatUnits(stats.pending, decimals)}`);
        console.log(`   Contract Balance:  ${formatUnits(contractBalance, decimals)}`);

        if (contractBalance < stats.pending) {
            console.error(`   ⚠️  WARNING: Contract Balance < Pending Rewards! (Deficit: ${formatUnits(stats.pending - contractBalance, decimals)})`);
            process.exit(1);
        } else {
            console.log(`   ✅  Solvency Check Passed`);
        }
        console.log("");
    }
    console.log("---------------------------------------------------");


    // 6. Verification Loop (Simulation)
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    console.log(`\n📝 Detailed Simulation Results:`);

    for (let i = 0; i < flatClaims.length; i++) {
        const claim = flatClaims[i];
        const result = claimedResults[i];
        const alreadyClaimed = result.result as bigint; // Checked success above

        const claimableDelta = claim.totalAmount - alreadyClaimed;

        if (claimableDelta === 0n) {
            skippedCount++;
            continue;
        }

        // --- SIMULATION (RAW RPC) ---
        try {
            // Prepare Calldata
            const calldata = encodeFunctionData({
                abi: merklAbi,
                functionName: 'claim',
                args: [claim.user, claim.token, claim.totalAmount, claim.proof]
            });

            // Prepare State Override Object
            const slot0 = pad("0x0", { size: 32 });
            const stateOverride = needsOverride ? {
                [MERKL_CONTRACT]: {
                    stateDiff: {
                        [slot0]: NEW_ROOT
                    }
                }
            } : undefined;

            const rawResult = await client.request({
                method: 'eth_call',
                params: [
                    {
                        to: MERKL_CONTRACT,
                        from: claim.user,
                        data: calldata
                    },
                    'latest',
                    stateOverride as any
                ]
            });

            const decodedAmount = decodeFunctionResult({
                abi: merklAbi,
                functionName: 'claim',
                data: rawResult
            });

            successCount++;
            const decimals = tokenInfo[claim.token].decimals;
            console.log(`✅ [SIMULATED] ${claim.user.slice(0, 6)}... | +${formatUnits(decodedAmount as bigint, decimals)} tokens`);

        } catch (error: any) {
            failCount++;
            console.error(`❌ [REVERT] Simulation failed for ${claim.user}`);
            // Error handling simplified for brevity
            const errStr = JSON.stringify(error, null, 2);
            if (errStr.includes("execution reverted")) {
                if (error.data) console.error(`   👉 Data: ${error.data}`);
            } else {
                console.error(`   👉 ${error.message}`);
            }
        }
    }

    console.log("---------------------------------------------------");
    console.log(`\n🏁 Summary:`);
    console.log(`   Fully Claimed (Skipped): ${skippedCount}`);
    console.log(`   Successful Simulations:  ${successCount}`);
    console.log(`   Failed Simulations:      ${failCount}`);

    if (failCount > 0) {
        console.error(`\n🚨 FAILURE: Some users cannot claim.`);
        process.exit(1);
    } else {
        console.log(`\n✨ SUCCESS: All claimable users verified via simulation.`);
    }
}