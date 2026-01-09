import {
    parseAbi,
    encodeAbiParameters,
    keccak256,
    formatUnits,
    getAddress,
    Hex,
    encodeFunctionData,
    pad,
    decodeFunctionResult,
    Hash,
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
    const tokenAddresses: Record<Address, boolean> = {};

    for (const [user, userDat] of Object.entries(claimsObj)) {
        const tokens = (userDat as any).tokens;
        for (const [token, tokenDat] of Object.entries(tokens)) {
            const tokenFormatted = getAddress(token as string);
            flatClaims.push({
                user: getAddress(user as string),
                token: tokenFormatted,
                totalAmount: BigInt((tokenDat as any).amount),
                proof: (tokenDat as any).proof as Hex[]
            });
            tokenAddresses[tokenFormatted] = true;
        }
    }

    console.log(`\n📊 Analyzing & Simulating ${flatClaims.length} claims...`);

    // 5. Fetch 'claimed' amounts (Multicall)
    const claimedResults = await client.multicall({
        contracts: flatClaims.map(c => ({
            address: MERKL_CONTRACT,
            abi: merklAbi,
            functionName: 'claimed',
            args: [c.user, c.token]
        }))
    });

    const decimals = await client.multicall({
        contracts: Object.keys(tokenAddresses).map(c => ({
            address: c,
            abi: erc20Abi,
            functionName: 'decimals',
            args: []
        })),
    });

    const tokenDecimals: Record<Address, number> = {};
    for (let i = 0; i < Object.keys(tokenAddresses).length; i++) {
        const res = decimals[i];
        if (res.status === 'success') {
            tokenDecimals[Object.keys(tokenAddresses)[i] as Address] = Number(BigInt(res.result));
        } else {
            throw new Error(res.error.message);
        }
    }

    // 6. Verification Loop
    let successCount = 0;
    let failCount = 0;

    console.log(`\n📝 Detailed Results:`);
    console.log("---------------------------------------------------");

    for (let i = 0; i < flatClaims.length; i++) {
        const claim = flatClaims[i];
        const result = claimedResults[i];

        if (result.status === 'failure') throw new Error(`RPC Failure for ${claim.user}`);

        const alreadyClaimed = result.result as bigint;

        if (claim.totalAmount < alreadyClaimed) {
            throw new Error(`🚨 CRITICAL: ${claim.user} JSON amount < OnChain claimed`);
        }

        const claimableDelta = claim.totalAmount - alreadyClaimed;

        if (claimableDelta === 0n) {
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
            // Slot 0 is 'root' in your contract (first declared variable)
            const slot0 = pad("0x0", { size: 32 });
            const stateOverride = needsOverride ? {
                [MERKL_CONTRACT]: {
                    stateDiff: {
                        [slot0]: NEW_ROOT
                    }
                }
            } : undefined;

            // Execute Raw eth_call
            // Params: [{to, data, from}, blockTag, stateOverride]
            const rawResult = await client.request({
                method: 'eth_call',
                params: [
                    {
                        to: MERKL_CONTRACT,
                        from: claim.user, // Simulate call from user
                        data: calldata
                    },
                    'latest',
                    stateOverride as any // Cast necessary as strict types might mismatch slightly
                ]
            });

            // Decode result (claim returns uint256 amount)
            const decodedAmount = decodeFunctionResult({
                abi: merklAbi,
                functionName: 'claim',
                data: rawResult
            });

            successCount++;
            const decimals = tokenDecimals[claim.token];
            console.log(`✅ [SIMULATED] ${claim.user.slice(0, 6)}...`);
            console.log(`   Claimed in sim: ${formatUnits(decodedAmount as bigint, decimals)} | Token: ${claim.token}`);

        } catch (error: any) {
            failCount++;
            console.error(`❌ [REVERT] Simulation failed for ${claim.user}`);

            // Try to parse the RPC error
            const errStr = JSON.stringify(error, null, 2);

            if (errStr.includes("execution reverted")) {
                console.error(`   👉 REASON: Execution Reverted (likely Invalid Proof or Transfer Failed)`);
                // Often the error message is buried in error.cause.data or error.data
                if (error.data) console.error(`   👉 Data: ${error.data}`);
            } else {
                console.error(`   👉 REASON: ${error.message || "Unknown RPC Error"}`);
            }
        }
    }

    console.log("---------------------------------------------------");
    console.log(`\n🏁 Summary:`);
    console.log(`   Successful Simulations: ${successCount}`);
    console.log(`   Failed Simulations:     ${failCount}`);

    if (failCount > 0) {
        console.error(`\n🚨 FAILURE: Some users cannot claim.`);
        process.exit(1);
    } else {
        console.log(`\n✨ SUCCESS: All claimable users verified via simulation.`);
    }
}

check();