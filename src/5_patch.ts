import fs from 'fs';
import path from 'path';
import { getAddress, formatUnits, erc20Abi, Address } from 'viem';
import { mainnet } from 'viem/chains';
import { MERKL_CONTRACT } from './constants';
import { getClient } from './utils/rpc';
import { merklAbi } from './abis/Merkl';
import { generateMerkleTree, writeLastMerkle, writeMerkle } from './utils/merkle';
import { UniversalMerkle } from './interfaces/UniversalMerkle';
import { MerkleData } from './interfaces/MerkleData';
import { safeStringify } from './utils/parse';
import { getLastDistributionsData } from './utils/distributionData';

export const patch = async () => {
    console.log("🩹 Starting merkle patch script...");

    // 1. Load last_merkle.json (correct amounts) — use JSON.parse to keep amounts as strings
    const lastMerklePath = path.resolve(__dirname, '../data/last_merkle.json');
    const lastMerkle: MerkleData = JSON.parse(fs.readFileSync(lastMerklePath, { encoding: 'utf-8' }));

    // 2. Convert MerkleData -> UniversalMerkle (strip proofs)
    const universalMerkle: UniversalMerkle = {};
    for (const [user, claim] of Object.entries(lastMerkle.claims)) {
        const userChecksum = getAddress(user);
        universalMerkle[userChecksum] = {};
        for (const [token, data] of Object.entries(claim.tokens)) {
            const tokenChecksum = getAddress(token);
            universalMerkle[userChecksum][tokenChecksum] = data.amount;
        }
    }

    // 3. Flatten all (user, token) pairs for multicall
    const flatClaims: { user: Address; token: Address; amount: string }[] = [];
    for (const [user, tokens] of Object.entries(universalMerkle)) {
        for (const [token, amount] of Object.entries(tokens)) {
            flatClaims.push({
                user: user as Address,
                token: token as Address,
                amount,
            });
        }
    }

    console.log(`📊 Total pairs to check: ${flatClaims.length}`);

    // 4. Fetch all claimed amounts onchain via multicall
    const client = await getClient(mainnet.id);

    // Batch multicall in chunks to avoid RPC limits
    const BATCH_SIZE = 500;
    const claimedResults: { status: string; result?: bigint }[] = [];

    for (let i = 0; i < flatClaims.length; i += BATCH_SIZE) {
        const batch = flatClaims.slice(i, i + BATCH_SIZE);
        const results = await client.multicall({
            contracts: batch.map((c) => ({
                address: MERKL_CONTRACT,
                abi: merklAbi,
                functionName: 'claimed',
                args: [c.user, c.token],
            })),
        });
        claimedResults.push(...results);

        if (i + BATCH_SIZE < flatClaims.length) {
            console.log(`   Fetched ${Math.min(i + BATCH_SIZE, flatClaims.length)}/${flatClaims.length} claimed amounts...`);
        }
    }

    console.log(`   Fetched ${claimedResults.length}/${flatClaims.length} claimed amounts.`);

    // 5. Fetch token decimals for display
    const distinctTokens = new Set<Address>(flatClaims.map((c) => c.token));
    const tokenList = Array.from(distinctTokens);

    const decimalsResults = await client.multicall({
        contracts: tokenList.map((t) => ({
            address: t,
            abi: erc20Abi,
            functionName: 'decimals',
            args: [],
        })),
    });

    const tokenDecimals: Record<Address, number> = {};
    for (let i = 0; i < tokenList.length; i++) {
        const res = decimalsResults[i];
        tokenDecimals[tokenList[i]] = res.status === 'success' ? Number(res.result) : 18;
    }

    // 6. Patch: if claimed > amount, set amount = claimed; accumulate debts
    let patchCount = 0;
    const debts: Record<Address, Record<Address, string>> = {};

    for (let i = 0; i < flatClaims.length; i++) {
        const { user, token, amount } = flatClaims[i];
        const res = claimedResults[i];

        if (res.status !== 'success') {
            console.error(`RPC failure for claimed(${user}, ${token})`);
            process.exit(1);
        }

        const claimed = res.result as bigint;
        const amountBn = BigInt(amount);

        if (claimed > amountBn) {
            const debt = claimed - amountBn;
            const decimals = tokenDecimals[token] ?? 18;
            const oldFormatted = formatUnits(amountBn, decimals);
            const newFormatted = formatUnits(claimed, decimals);
            console.log(`🔧 PATCHED: ${user} | ${token} | ${oldFormatted} -> ${newFormatted}`);
            universalMerkle[user][token] = claimed.toString();

            if (!debts[user]) debts[user] = {};
            debts[user][token] = debt.toString();

            patchCount++;
        }
    }

    console.log(`\n📋 Total pairs patched: ${patchCount}`);

    // Write debts.json if patches were found and file doesn't already exist
    if (patchCount > 0) {
        const debtsPath = path.resolve(__dirname, '../data/debts.json');
        if (!fs.existsSync(debtsPath)) {
            fs.writeFileSync(debtsPath, safeStringify(debts), { encoding: 'utf-8' });
            console.log(`💾 Debts saved to ${debtsPath}`);

            const initialDebtsPath = path.resolve(__dirname, '../data/initial_debts.json');
            fs.writeFileSync(initialDebtsPath, safeStringify(debts), { encoding: 'utf-8' });
        } else {
            console.log(`⚠️  data/debts.json already exists — skipping write (debts may have been partially repaid)`);
        }

        // Deficit report: total per token that treasury must deposit
        const deficitPerToken: Record<Address, bigint> = {};
        for (const tokens of Object.values(debts)) {
            for (const [token, amount] of Object.entries(tokens)) {
                const t = token as Address;
                deficitPerToken[t] = (deficitPerToken[t] || 0n) + BigInt(amount);
            }
        }

        console.log(`\n💰 Deficit report — treasury must deposit:`);
        for (const [token, total] of Object.entries(deficitPerToken)) {
            const decimals = tokenDecimals[token as Address] ?? 18;
            console.log(`   ${token}: ${formatUnits(total, decimals)} (${total.toString()} raw)`);
        }
    }

    if (patchCount === 0) {
        console.log("✅ No patches needed — merkle is already consistent with onchain claims.");
        return;
    }

    // 7. Regenerate merkle tree
    console.log("\n🌳 Regenerating merkle tree...");
    const patchedMerkle = generateMerkleTree(universalMerkle);

    // 8. Save to last_merkle.json and current distribution's merkle file
    writeLastMerkle(patchedMerkle);

    const distributionsData = getLastDistributionsData();
    const lastSent = [...distributionsData].reverse().find(d => d.sentOnchain);
    if (lastSent) {
        writeMerkle(lastSent.timestamp, patchedMerkle);
        console.log(`💾 Patched merkle also saved to distribution ${lastSent.timestamp}`);
    }

    const patchedPath = path.resolve(__dirname, '../data/patched_merkle.json');
    fs.writeFileSync(patchedPath, safeStringify(patchedMerkle), { encoding: 'utf-8' });
    console.log(`💾 Patched merkle saved to ${patchedPath}`);

    // 9. Summary
    const userCount = Object.keys(patchedMerkle.claims).length;
    let tokenCount = 0;
    for (const claim of Object.values(patchedMerkle.claims)) {
        tokenCount += Object.keys(claim.tokens).length;
    }
    console.log(`\n✅ Patched merkle: ${userCount} users, ${tokenCount} token pairs`);
    console.log(`   New root: ${patchedMerkle.merkleRoot}`);
};

// Allow direct execution
if (require.main === module) {
    patch().catch((err) => {
        console.error("❌ Patch failed:", err);
        process.exit(1);
    });
}