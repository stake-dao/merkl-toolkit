import axios from "axios";
import { getAddress } from "viem";
import { MERKL_CONTRACT, TREASURY_ADDRESS } from "../constants";
import { merklAbi } from "../abis/Merkl";
import { MerkleData } from "../interfaces/MerkleData";
import { generateMerkleTree } from "./merkle";
import { getClient } from "./rpc";

const amounts = (merkle: MerkleData) => Object.fromEntries(Object.entries(merkle.claims).map(([account, claim]) => [
    getAddress(account), Object.fromEntries(Object.entries(claim.tokens).map(([token, leaf]) => [getAddress(token), String(leaf.amount)])),
]));

const isExpiryOf = (parent: MerkleData, active: MerkleData): boolean => {
    const before = amounts(parent);
    const after = amounts(active);
    const recovered: Record<string, bigint> = {};
    for (const [account, tokens] of Object.entries(before)) {
        if (account === TREASURY_ADDRESS) {
            for (const token of Object.keys(tokens)) recovered[token] ??= 0n;
            continue;
        }
        for (const [token, amount] of Object.entries(tokens)) {
            if (after[account]?.[token] === undefined || BigInt(after[account][token]) > BigInt(amount)) return false;
            recovered[token] = (recovered[token] ?? 0n) + BigInt(amount) - BigInt(after[account][token]);
        }
    }
    for (const [account, tokens] of Object.entries(after)) {
        for (const token of Object.keys(tokens)) {
            if (before[account]?.[token] === undefined) return false;
        }
    }
    return Object.entries(recovered).every(([token, amount]) =>
        BigInt(after[TREASURY_ADDRESS]?.[token] ?? "0") - BigInt(before[TREASURY_ADDRESS]?.[token] ?? "0") === amount
    );
};

export async function activeExpiryBaseline(previous: MerkleData): Promise<{ merkle: MerkleData; root: string; firstDistribution?: number }> {
    const client = await getClient(1);
    const root = await client.readContract({ address: MERKL_CONTRACT, abi: merklAbi, functionName: "root" });
    if (root === previous.merkleRoot || (/^0x0{64}$/.test(root) && !previous.merkleRoot)) return { merkle: previous, root };
    const { data: active } = await axios.get<MerkleData>("https://hub.stakedao.org/v1/merkles/active?chainId=1&target=extra");
    if (active.merkleRoot !== root || generateMerkleTree(amounts(active)).merkleRoot !== root) throw new Error("Active extra root mismatch");
    if (isExpiryOf(previous, active)) return { merkle: active, root };
    if (!previous.parentRoot || !Number.isSafeInteger(previous.firstDistribution)) throw new Error("Unpublished reward history missing");
    let parent = active;
    if (previous.parentRoot !== root) {
        const response = await axios.get<MerkleData>(`https://raw.githubusercontent.com/stake-dao/bounties-report/main/bounties-reports/expiry/extra/roots/1/${previous.parentRoot}.json`);
        parent = response.data;
    }
    if (generateMerkleTree(amounts(parent)).merkleRoot !== previous.parentRoot || !isExpiryOf(parent, active)) throw new Error("Unpublished reward parent mismatch");
    const combined = amounts(active);
    const before = amounts(parent);
    const pending = amounts(previous);
    for (const [account, tokens] of Object.entries(before)) {
        for (const token of Object.keys(tokens)) {
            if (pending[account]?.[token] === undefined) throw new Error("Unpublished rewards remove a leaf");
        }
    }
    for (const [account, tokens] of Object.entries(pending)) {
        combined[account] ??= {};
        for (const [token, amount] of Object.entries(tokens)) {
            const delta = BigInt(amount) - BigInt(before[account]?.[token] ?? "0");
            if (delta < 0n) throw new Error("Unpublished rewards reduce a leaf");
            combined[account][token] = (BigInt(combined[account][token] ?? "0") + delta).toString();
        }
    }
    return { merkle: generateMerkleTree(combined), root, firstDistribution: previous.firstDistribution };
}
