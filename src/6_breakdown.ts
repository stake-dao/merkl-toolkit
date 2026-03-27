import fs from "fs";
import path from "path";
import { Address, getAddress } from "viem";
import { mainnet } from "viem/chains";
import { getClient } from "./utils/rpc";
import { getDistribution } from "./utils/distribution";
import { getLastDistributionsData } from "./utils/distributionData";
import { readMeta, writeMeta, emptyMeta, readEarnedEntries, writeEarnedEntries, readClaimEvents, writeClaimEvents, writeBreakdown } from "./utils/breakdown";
import { Breakdown, VaultTokenBreakdown, ProductType, EarnedSource, SerializedEarnedEntry, SerializedClaimEvent } from "./interfaces/Breakdown";
import { MERKL_CONTRACT } from "./constants";
import { merklAbi } from "./abis/Merkl";
import { MerkleData } from "./interfaces/MerkleData";
import { safeParse } from "./utils/parse";
import * as dotenv from "dotenv";

dotenv.config();

const BATCH_SIZE = 500;
const DATA_DIR = path.resolve(__dirname, "../data");

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MERKL_FROM_TOPIC = "0x" + MERKL_CONTRACT.slice(2).toLowerCase().padStart(64, "0");

// ── Types (in-memory, same shape as serialized but typed for Address) ─

interface EarnedEntry {
    timestamp: number;
    vault: Address;
    amount: bigint;
    source: EarnedSource;
}

interface ClaimEvent {
    blockNumber: bigint;
    timestamp: number;
    user: Address;
    amount: bigint;
}

type TimelineEvent =
    | { type: "earn"; timestamp: number; vault: Address; amount: bigint }
    | { type: "claim"; timestamp: number; amount: bigint };

// ── Etherscan fetch with retry (same pattern as TokenHolderScanner) ──

const fetchWithRetry = async (url: string, maxRetries = 50, baseDelay = 1000): Promise<any> => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url);

            if (response.status === 429) {
                const delay = baseDelay * Math.pow(2, attempt);
                console.log(`⏳ Rate limit, retrying in ${delay}ms (${attempt + 1}/${maxRetries})...`);
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data: any = await response.json();
            const msg = (data.message || "").toLowerCase();
            if (data.status === "0" && (msg.includes("rate limit") || msg.includes("max rate") || msg === "notok")) {
                const delay = baseDelay * Math.pow(2, attempt);
                console.log(`⏳ Etherscan rate limit, retrying in ${delay}ms (${attempt + 1}/${maxRetries})...`);
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }

            return data;
        } catch (error) {
            if (attempt === maxRetries - 1) throw error;
            const delay = baseDelay * Math.pow(2, attempt);
            console.log(`⚠️ Network error, retrying in ${delay}ms (${attempt + 1}/${maxRetries})...`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw new Error(`Failed after ${maxRetries} attempts`);
};

// ── Phase 1: Accumulate earned entries (incremental) ─────────────────

// Load all known Morpho depositor addresses from caches on disk.
// Used as fallback for old distribution files that don't have the source field.
const loadMorphoDepositors = (): Set<string> => {
    const morphoDir = path.resolve(DATA_DIR, "holders/morpho");
    if (!fs.existsSync(morphoDir)) return new Set();

    const depositors = new Set<string>();
    for (const wrapper of fs.readdirSync(morphoDir)) {
        const indexPath = path.resolve(morphoDir, wrapper, "index.json");
        if (!fs.existsSync(indexPath)) continue;
        const data = safeParse(fs.readFileSync(indexPath, { encoding: "utf-8" }));
        for (const user of data.users ?? []) {
            depositors.add(getAddress(user).toLowerCase());
        }
    }
    return depositors;
};

const accumulateNewDistributions = (
    existingEntries: Record<string, SerializedEarnedEntry[]>,
    lastProcessedTimestamp: number,
): { entries: Record<string, SerializedEarnedEntry[]>; newTimestamp: number; count: number } => {
    const distributionsData = getLastDistributionsData();
    const toProcess = distributionsData
        .filter((d) => d.sentOnchain && d.timestamp > lastProcessedTimestamp)
        .sort((a, b) => a.timestamp - b.timestamp);

    if (toProcess.length === 0) {
        return { entries: existingEntries, newTimestamp: lastProcessedTimestamp, count: 0 };
    }

    // Load Morpho depositor set for old files without source field
    const morphoDepositors = loadMorphoDepositors();
    if (morphoDepositors.size > 0) {
        console.log(`🔌 Loaded ${morphoDepositors.size} known Morpho depositor(s) from cache`);
    }

    console.log(`📝 Processing ${toProcess.length} new distribution(s)...`);
    const entries = { ...existingEntries };

    for (const dist of toProcess) {
        const distribution = getDistribution(dist.timestamp);
        for (const incentive of distribution.incentives) {
            const vault = getAddress(incentive.vault);
            const token = getAddress(incentive.token.address);

            for (const user of incentive.users) {
                const addr = getAddress(user.user);
                const key = `${addr}-${token}`;
                if (!entries[key]) entries[key] = [];

                // Determine source: explicit field (new files) or heuristic (old files)
                let source: EarnedSource;
                if (user.source) {
                    source = user.source;
                } else {
                    // Old file: balance == 0 + in Morpho cache → morpho
                    const isZeroBalance = BigInt(user.balance) === 0n;
                    const isMorphoDepositor = morphoDepositors.has(addr.toLowerCase());
                    source = isZeroBalance && isMorphoDepositor ? "morpho" : "direct";
                }

                entries[key].push({
                    timestamp: dist.timestamp,
                    vault,
                    amount: BigInt(user.amount),
                    source,
                });
            }
        }
    }

    return {
        entries,
        newTimestamp: toProcess[toProcess.length - 1].timestamp,
        count: toProcess.length,
    };
};

// ── Phase 2: Scan claim events (incremental) ────────────────────────

const scanNewClaimEvents = async (
    existingClaims: Record<string, SerializedClaimEvent[]>,
    fromBlock: bigint,
    toBlock: bigint,
): Promise<{ claims: Record<string, SerializedClaimEvent[]>; newBlock: number; count: number }> => {
    if (fromBlock > toBlock) {
        return { claims: existingClaims, newBlock: Number(toBlock), count: 0 };
    }

    const apiKey = process.env.ETHERSCAN_API_KEY;
    if (!apiKey) throw new Error("ETHERSCAN_API_KEY not set");

    const claims = { ...existingClaims };
    const step = 10_000n;
    const pageSize = 1000;
    let totalNew = 0;

    const fetchRange = async (from: bigint, to: bigint) => {
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const url =
                `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs` +
                `&topic0=${TRANSFER_TOPIC}` +
                `&topic1=${MERKL_FROM_TOPIC}` +
                `&topic0_1_opr=and` +
                `&fromBlock=${from}&toBlock=${to}` +
                `&page=${page}&offset=${pageSize}` +
                `&apikey=${apiKey}`;

            const data = await fetchWithRetry(url);

            if (data.status === "0" && data.message?.includes("Result window is too large")) {
                const mid = from + (to - from) / 2n;
                console.log(`⚠️ Window too large (${from}-${to}), splitting...`);
                await fetchRange(from, mid);
                await fetchRange(mid + 1n, to);
                return;
            }

            if (
                (data.status === "1" && (!data.result || data.result.length === 0)) ||
                (data.status === "0" && data.message?.includes("No records found"))
            ) {
                hasMore = false;
                break;
            }

            if (data.status !== "1") {
                throw new Error(`Etherscan error blocks ${from}-${to}: ${data.message}`);
            }

            for (const log of data.result) {
                const topics = log.topics;
                if (topics.length >= 3) {
                    const token = getAddress(log.address) as Address;
                    const user = getAddress("0x" + topics[2].slice(26)) as Address;
                    const key = `${user}-${token}`;

                    if (!claims[key]) claims[key] = [];
                    claims[key].push({
                        blockNumber: BigInt(log.blockNumber),
                        timestamp: log.timeStamp.startsWith("0x")
                            ? parseInt(log.timeStamp, 16)
                            : Number(log.timeStamp),
                        user,
                        amount: BigInt(log.data),
                    });
                    totalNew++;
                }
            }

            hasMore = data.result.length >= pageSize;
            if (hasMore) page++;
            await new Promise((r) => setTimeout(r, 400));
        }
    };

    for (let start = fromBlock; start <= toBlock; start += step) {
        const end = start + step - 1n > toBlock ? toBlock : start + step - 1n;

        let attempts = 0;
        while (attempts < 3) {
            try {
                await fetchRange(start, end);
                break;
            } catch (error) {
                attempts++;
                if (attempts >= 3) throw error;
                console.log(`⚠️ Retrying blocks ${start}-${end} (${attempts}/3)...`);
                await new Promise((r) => setTimeout(r, 2000 * attempts));
            }
        }
    }

    console.log(`✅ ${totalNew} new claim events`);
    return { claims, newBlock: Number(toBlock), count: totalNew };
};

// ── Phase 3: Fetch current claimed amounts ──────────────────────────

const fetchClaimedAmounts = async (
    client: any,
    pairs: { user: Address; token: Address }[],
): Promise<Map<string, bigint>> => {
    const claimed = new Map<string, bigint>();

    for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
        const batch = pairs.slice(i, i + BATCH_SIZE);
        const results = await client.multicall({
            contracts: batch.map((p) => ({
                address: MERKL_CONTRACT,
                abi: merklAbi,
                functionName: "claimed" as const,
                args: [p.user, p.token] as const,
            })),
        });

        for (let j = 0; j < batch.length; j++) {
            const res = results[j];
            if (res.status !== "success") {
                console.error(`❌ claimed() failed for ${batch[j].user} / ${batch[j].token}`);
                process.exit(1);
            }
            claimed.set(`${batch[j].user}-${batch[j].token}`, res.result as bigint);
        }

        if (pairs.length > BATCH_SIZE) {
            console.log(`   ${Math.min(i + BATCH_SIZE, pairs.length)}/${pairs.length}...`);
        }
    }

    return claimed;
};

// ── Phase 4: Process timeline per (user, token) ─────────────────────

const processUserToken = (
    earnedEntries: EarnedEntry[],
    claimEvents: ClaimEvent[],
    merkleTotal: bigint,
    claimedOnChain: bigint,
): Map<Address, VaultTokenBreakdown> => {
    const timeline: TimelineEvent[] = [];
    for (const e of earnedEntries) {
        timeline.push({ type: "earn", timestamp: e.timestamp, vault: e.vault, amount: e.amount });
    }
    for (const c of claimEvents) {
        timeline.push({ type: "claim", timestamp: c.timestamp, amount: c.amount });
    }

    // Sort: by timestamp, earn before claim at same timestamp
    timeline.sort((a, b) => {
        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
        return a.type === "earn" ? -1 : 1;
    });

    const vaultEarned = new Map<Address, bigint>();
    const vaultClaimed = new Map<Address, bigint>();
    const vaultSources = new Map<Address, Set<EarnedSource>>();

    // Track sources per vault from earned entries
    for (const e of earnedEntries) {
        const sources = vaultSources.get(e.vault) ?? new Set();
        sources.add(e.source);
        vaultSources.set(e.vault, sources);
    }

    for (const event of timeline) {
        if (event.type === "earn") {
            vaultEarned.set(event.vault, (vaultEarned.get(event.vault) ?? 0n) + event.amount);
        } else {
            const pending = new Map<Address, bigint>();
            let totalPending = 0n;

            for (const [vault, earned] of vaultEarned.entries()) {
                const claimed = vaultClaimed.get(vault) ?? 0n;
                const p = earned - claimed;
                if (p > 0n) {
                    pending.set(vault, p);
                    totalPending += p;
                }
            }

            if (totalPending === 0n) continue;

            const claimAmount = event.amount > totalPending ? totalPending : event.amount;
            const vaults = Array.from(pending.entries()).sort((a, b) => Number(b[1] - a[1]));
            let allocated = 0n;

            for (let i = 0; i < vaults.length; i++) {
                const [vault, vaultPending] = vaults[i];
                const share =
                    i === vaults.length - 1
                        ? claimAmount - allocated
                        : (claimAmount * vaultPending) / totalPending;
                allocated += share;
                vaultClaimed.set(vault, (vaultClaimed.get(vault) ?? 0n) + share);
            }
        }
    }

    // Build result with merkle-reconciled claimable
    const pendingOnChain = merkleTotal > claimedOnChain ? merkleTotal - claimedOnChain : 0n;
    const allVaults = Array.from(vaultEarned.keys());
    const vaultRemaining = new Map<Address, bigint>();
    let totalRemaining = 0n;

    for (const vault of allVaults) {
        const earned = vaultEarned.get(vault)!;
        const claimed = vaultClaimed.get(vault) ?? 0n;
        const remaining = earned > claimed ? earned - claimed : 0n;
        vaultRemaining.set(vault, remaining);
        totalRemaining += remaining;
    }

    const totalEarned = allVaults.reduce((a, v) => a + (vaultEarned.get(v) ?? 0n), 0n);
    const useRemaining = totalRemaining > 0n;
    const ratioBase = useRemaining ? totalRemaining : totalEarned;

    const sortedVaults = [...allVaults].sort((a, b) => {
        const ra = useRemaining ? (vaultRemaining.get(a) ?? 0n) : (vaultEarned.get(a) ?? 0n);
        const rb = useRemaining ? (vaultRemaining.get(b) ?? 0n) : (vaultEarned.get(b) ?? 0n);
        return Number(rb - ra);
    });

    const result = new Map<Address, VaultTokenBreakdown>();
    let allocatedClaimable = 0n;

    for (let i = 0; i < sortedVaults.length; i++) {
        const vault = sortedVaults[i];
        const earned = vaultEarned.get(vault)!;
        const claimed = vaultClaimed.get(vault) ?? 0n;
        const ratio = useRemaining ? (vaultRemaining.get(vault) ?? 0n) : earned;

        let claimable: bigint;
        if (ratioBase === 0n) {
            claimable = 0n;
        } else if (i === sortedVaults.length - 1) {
            claimable = pendingOnChain - allocatedClaimable;
        } else {
            claimable = (pendingOnChain * ratio) / ratioBase;
        }
        allocatedClaimable += claimable;

        const sources = vaultSources.get(vault);
        const productType: ProductType = sources?.has("direct") && sources?.has("morpho")
            ? "both"
            : sources?.has("morpho") ? "morpho" : "direct";

        result.set(vault, {
            earned: earned.toString(),
            claimed: claimed.toString(),
            claimable: claimable.toString(),
            type: productType,
        });
    }

    return result;
};

// ── Main ─────────────────────────────────────────────────────────────

export const buildBreakdown = async (rebuild: boolean = false) => {
    console.log("📊 Starting breakdown generation...");

    if (!fs.existsSync(DATA_DIR)) {
        console.log("⚠️ No data directory found");
        return;
    }

    // Load or reset state
    let meta = rebuild ? emptyMeta() : readMeta();
    let earnedEntries = rebuild ? {} : readEarnedEntries();
    let claimEvents = rebuild ? {} : readClaimEvents();

    if (rebuild) {
        console.log("🔄 Rebuilding from scratch...");
    } else if (meta.lastProcessedTimestamp > 0) {
        console.log(`📂 Loaded state (last dist: ${meta.lastProcessedTimestamp}, last block: ${meta.lastScannedBlock})`);
    }

    // Phase 1: Accumulate earned entries (incremental)
    const { entries, newTimestamp, count: distCount } = accumulateNewDistributions(
        earnedEntries,
        meta.lastProcessedTimestamp,
    );
    earnedEntries = entries;
    if (newTimestamp > 0) meta.lastProcessedTimestamp = newTimestamp;

    if (distCount > 0) {
        console.log(`✅ ${distCount} distribution(s) processed`);
    } else {
        console.log("✅ Earned entries up to date");
    }

    const allKeys = Object.keys(earnedEntries);
    if (allKeys.length === 0) {
        console.log("⚠️ No earned entries");
        return;
    }

    // Phase 2: Scan claim events (incremental)
    const client = await getClient(mainnet.id);
    const currentBlock = await client.getBlockNumber();

    let scanFromBlock: bigint;
    if (meta.lastScannedBlock > 0) {
        scanFromBlock = BigInt(meta.lastScannedBlock) + 1n;
    } else {
        const distributionsData = getLastDistributionsData();
        const sent = distributionsData.filter((d) => d.sentOnchain).sort((a, b) => a.timestamp - b.timestamp);
        scanFromBlock = sent.length > 0 ? BigInt(sent[0].blockNumber) : currentBlock;
    }

    console.log(`🔗 Scanning claim events (blocks ${scanFromBlock}→${currentBlock})...`);
    const { claims, newBlock, count: claimCount } = await scanNewClaimEvents(
        claimEvents,
        scanFromBlock,
        currentBlock,
    );
    claimEvents = claims;
    meta.lastScannedBlock = newBlock;

    // Phase 3: Fetch current claimed amounts
    const pairs: { user: Address; token: Address }[] = [];
    const seen = new Set<string>();
    for (const key of allKeys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const [user, token] = key.split("-") as [Address, Address];
        pairs.push({ user, token });
    }

    console.log(`🔗 Fetching claimed amounts for ${pairs.length} pairs...`);
    const claimedMap = await fetchClaimedAmounts(client, pairs);

    // Load merkle
    const merklePath = path.resolve(DATA_DIR, "last_merkle.json");
    if (!fs.existsSync(merklePath)) {
        console.log("⚠️ No last_merkle.json found");
        return;
    }
    const merkle = safeParse(fs.readFileSync(merklePath, { encoding: "utf-8" })) as MerkleData;
    const merkleAmounts = new Map<string, bigint>();
    for (const [user, claim] of Object.entries(merkle.claims)) {
        for (const [token, data] of Object.entries(claim.tokens)) {
            merkleAmounts.set(`${getAddress(user)}-${getAddress(token)}`, BigInt(data.amount));
        }
    }

    // Phase 4: Process all timelines
    console.log("📐 Processing timelines...");
    const breakdown: Breakdown = {};

    for (const key of allKeys) {
        const [user, token] = key.split("-") as [Address, Address];

        const earned: EarnedEntry[] = (earnedEntries[key] ?? []).map((e) => ({
            timestamp: e.timestamp,
            vault: e.vault as Address,
            amount: BigInt(e.amount),
            source: (e.source ?? "direct") as EarnedSource,
        }));
        const claimEvts: ClaimEvent[] = (claimEvents[key] ?? []).map((c) => ({
            blockNumber: BigInt(c.blockNumber),
            timestamp: c.timestamp,
            user: c.user as Address,
            amount: BigInt(c.amount),
        }));

        const merkleTotal = merkleAmounts.get(key) ?? 0n;
        const claimedOnChain = claimedMap.get(key) ?? 0n;

        const vaultResults = processUserToken(earned, claimEvts, merkleTotal, claimedOnChain);

        if (!breakdown[user]) breakdown[user] = {};
        for (const [vault, data] of vaultResults.entries()) {
            if (!breakdown[user][vault]) breakdown[user][vault] = {};
            breakdown[user][vault][token] = data;
        }
    }

    // Phase 5: Write all files separately
    writeMeta(meta);
    writeEarnedEntries(earnedEntries);
    writeClaimEvents(claimEvents);
    writeBreakdown(breakdown);

    const userCount = Object.keys(breakdown).length;
    console.log(`🏁 Breakdown complete (${userCount} users, ${distCount} new dists, ${claimCount} new claims)`);
};

// Allow direct execution
if (require.main === module) {
    const rebuild = process.argv.includes("--rebuild");
    buildBreakdown(rebuild).catch((err) => {
        console.error("❌ Breakdown failed:", err);
        process.exit(1);
    });
}
