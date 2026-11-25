import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Address, getAddress, Hash, parseAbi, parseAbiItem, PublicClient, zeroAddress } from "viem";
import { DEFAULT_LOG_CHUNK_SIZE } from "../../utils/chain";
import { safeParse, safeStringify } from "../../utils/parse";

// FiRM's Ethereum DBR contract only adds markets and emits AddMarket on each registration.
const DBR = getAddress("0xAD038Eb671c44b853887A7E32528FaB35dC5D710");
const DBR_DEPLOYMENT = 16_155_758n;
const addMarket = parseAbiItem("event AddMarket(address indexed market)");
const createEscrow = parseAbiItem("event CreateEscrow(address indexed user, address escrow)");
const marketAbi = parseAbi(["function escrows(address user) view returns (address)"]);
const defaultCachePath = path.resolve(__dirname, "../../../data/holders/firm/index.json");

type Client = Pick<PublicClient, "chain" | "getLogs" | "getCode" | "getBlock" | "multicall">;

interface Checkpoint {
    blockNumber: bigint;
    blockHash: Hash;
    markets: Address[];
    owners: [Address, Address][];
}

// Bound both the block range accepted by the RPC and the number of concurrent calls
// during the one-time backfill. A failed page aborts the scan before the cursor moves.
async function scanLogs<T>(
    event: string, from: bigint, to: bigint, query: (from: bigint, to: bigint) => Promise<T[]>,
): Promise<T[]> {
    const result: T[] = [];
    const totalPages = (to - from) / DEFAULT_LOG_CHUNK_SIZE + 1n;
    let completed = 0;
    const reportProgress = () => console.log(`[FiRM] ${event}: ${completed}/${totalPages} pages, ${result.length} events`);
    console.log(`[FiRM] Scanning ${event} from block ${from} to ${to} (${totalPages} pages)`);
    const progressTimer = setInterval(reportProgress, 30_000);
    try {
        while (from <= to) {
            const pages: Promise<T[]>[] = [];
            for (let i = 0; i < 4 && from <= to; i++) {
                const fromBlock = from;
                const end = fromBlock + DEFAULT_LOG_CHUNK_SIZE - 1n;
                const toBlock = end < to ? end : to;
                pages.push(query(fromBlock, toBlock).catch(error => {
                    console.error(`[FiRM] ${event} failed on blocks ${fromBlock}–${toBlock}`);
                    throw error;
                }));
                from = toBlock + 1n;
            }
            for (const page of await Promise.all(pages)) result.push(...page);
            completed += pages.length;
        }
        reportProgress();
    } finally {
        clearInterval(progressTimer);
    }
    return result;
}

async function readEscrows(client: Client, markets: Address[], from: bigint, to: bigint) {
    if (!markets.length) return [];
    const scope = markets.length === 1 ? markets[0] : `${markets.length} markets`;
    return scanLogs(`CreateEscrow (${scope})`, from, to, (fromBlock, toBlock) =>
        client.getLogs({ address: markets, event: createEscrow, fromBlock, toBlock }),
    );
}

// A deposit can create an escrow before governance authorizes borrowing on its market.
// When a newly registered market already existed at the previous cursor, backfill it
// from deployment. This also handles markets deployed before DBR itself.
async function deploymentAtOrBefore(client: Client, address: Address, block: bigint) {
    const hasCode = async (blockNumber: bigint) => {
        const code = await client.getCode({ address, blockNumber });
        return !!code && code !== "0x";
    };
    if (!await hasCode(block)) return undefined;
    let low = 0n;
    let high = block;
    while (low < high) {
        const mid = (low + high) / 2n;
        if (await hasCode(mid)) high = mid;
        else low = mid + 1n;
    }
    return low;
}

/** Canonical FiRM escrow => borrower as of one Ethereum block, both checksummed. */
export async function getFirmEscrowOwners(
    client: Client, blockNumber: bigint, cachePath = defaultCachePath,
): Promise<Map<Address, Address>> {
    if (client.chain?.id !== 1) throw new Error("FiRM registry requires an Ethereum mainnet client");
    if (blockNumber < DBR_DEPLOYMENT) return new Map();

    console.log(`[FiRM] Indexing markets and escrows at block ${blockNumber}`);
    const snapshot = await client.getBlock({ blockNumber });
    if (!snapshot.hash) throw new Error(`Missing hash for FiRM snapshot block ${blockNumber}`);
    const stored: Checkpoint | undefined = fs.existsSync(cachePath)
        ? safeParse(fs.readFileSync(cachePath, "utf8"))
        : undefined;
    if (stored && (typeof stored.blockNumber !== "bigint" || !stored.blockHash ||
        !Array.isArray(stored.markets) || !Array.isArray(stored.owners))) {
        throw new Error("Incomplete FiRM registry checkpoint");
    }

    // Never use later discoveries for an earlier snapshot, or data from a reorged chain.
    let checkpoint: Checkpoint | undefined;
    if (stored && stored.blockNumber <= blockNumber) {
        const anchor = stored.blockNumber === blockNumber
            ? snapshot : await client.getBlock({ blockNumber: stored.blockNumber });
        if (anchor.hash === stored.blockHash) checkpoint = stored;
    }
    const owners = new Map(checkpoint?.owners);
    if (checkpoint?.blockNumber === blockNumber) {
        console.log(`[FiRM] Reusing checkpoint at block ${blockNumber} (${owners.size} escrows)`);
        return owners;
    }

    const from = checkpoint ? checkpoint.blockNumber + 1n : DBR_DEPLOYMENT;
    const markets = new Set(checkpoint?.markets);
    const registrations = await scanLogs("AddMarket", from, blockNumber, (fromBlock, toBlock) =>
        client.getLogs({ address: DBR, event: addMarket, fromBlock, toBlock }),
    );
    const added = new Set<Address>();
    for (const log of registrations) {
        if (getAddress(log.address) !== DBR) throw new Error("Unexpected FiRM registration emitter");
        const market = getAddress(log.args.market);
        if (!markets.has(market)) added.add(market);
        markets.add(market);
    }

    const logs = await readEscrows(client, [...markets], from, blockNumber);
    for (const market of added) {
        console.log(`[FiRM] Checking deployment history for market ${market}`);
        const deployment = await deploymentAtOrBefore(client, market, from - 1n);
        if (deployment !== undefined) {
            for (const log of await readEscrows(client, [market], deployment, from - 1n)) logs.push(log);
        }
    }

    // Cross-check the emitted pair against the market itself, independent of the escrow
    // implementation. This works for escrows without a beneficiary() getter.
    for (let i = 0; i < logs.length; i += 100) {
        console.log(`[FiRM] Verifying escrow events ${i + 1}–${Math.min(i + 100, logs.length)}/${logs.length} at block ${blockNumber}`);
        const batch = logs.slice(i, i + 100).map(log => {
            const market = getAddress(log.address);
            if (!markets.has(market)) throw new Error(`Unregistered FiRM market ${market}`);
            return { market, owner: getAddress(log.args.user), escrow: getAddress(log.args.escrow) };
        });
        const resolved = await client.multicall({
            blockNumber,
            authorizationList: undefined,
            allowFailure: false,
            contracts: batch.map(({ market, owner }) => ({
                address: market, abi: marketAbi, functionName: "escrows" as const, args: [owner] as const,
            })),
        });
        for (const [j, { market, owner, escrow }] of batch.entries()) {
            if (escrow === zeroAddress || getAddress(resolved[j]) !== escrow) {
                throw new Error(`Invalid FiRM escrow ${escrow} for ${owner} on ${market}`);
            }
            // FiRM allows deposits on behalf of address(0), which has no borrower.
            if (owner === zeroAddress) continue;
            if (owners.has(escrow) && owners.get(escrow) !== owner) {
                throw new Error(`Conflicting FiRM borrowers for escrow ${escrow}`);
            }
            owners.set(escrow, owner);
        }
    }

    if ((await client.getBlock({ blockNumber })).hash !== snapshot.hash) {
        throw new Error(`Ethereum reorg while resolving FiRM snapshot ${blockNumber}`);
    }
    if (!stored || stored.blockNumber <= blockNumber) {
        const next: Checkpoint = { blockNumber, blockHash: snapshot.hash, markets: [...markets], owners: [...owners] };
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        const temporary = `${cachePath}.${randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporary, safeStringify(next));
            fs.renameSync(temporary, cachePath);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }
    console.log(`[FiRM] Verified ${markets.size} markets and ${owners.size} escrows at block ${blockNumber}`);
    return owners;
}
