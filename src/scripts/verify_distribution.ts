import fs from "fs";
import path from "path";
import { Address, erc20Abi, getAddress } from "viem";
import { mainnet } from "viem/chains";
import * as dotenv from "dotenv";

import { getClient } from "../utils/rpc";
import { getIncentives } from "../utils/incentives";
import { getLastDistributionsData } from "../utils/distributionData";
import { blockAtOrAfter, blockAtOrBefore, getBlockTimestamp, BlockTimestampCache } from "../utils/chain";

dotenv.config();

/**
 * Independent verification of a distribution.
 *
 * Goal: cross-check the amounts computed by step 2 (TWAB via Transfer event
 * replay) through a path that shares ZERO lines with twab.ts or
 * 2_distribution.ts.
 *
 * Phase A — exact invariants (no RPC calls):
 *   A1. sum(user amounts) == amountToDistribute for each incentive
 *   A2. amountToDistribute == incentivePerSecond * (endWindow - startWindow)
 *   A3. incentivePerSecond == floor(incentive.amount / (end - start))
 *   A4. sum(sharePercentage) ~ 100% in the gauge snapshots
 *   A5. cross-run: no window overlap between successive runs (double
 *       distribution), no spending beyond the incentive's budget
 *
 * Phase B — on-chain sampling (independent method):
 *   A user's TWAB weight is integral( balance(t) / totalSupply(t) dt ).
 *   We approximate this integral with the trapezoidal rule: read
 *   balanceOf(user) and totalSupply() at N evenly spaced blocks within the
 *   window (archive node), then compare the resulting relative shares to the
 *   sharePercentage stored in gauges/{vault}.json (pre-expansion weights).
 *   Bonus: at each sample, if sum(balances) < totalSupply, some holders were
 *   missed by the Etherscan scan.
 *
 * Usage:
 *   npx ts-node src/scripts/verify_distribution.ts [--timestamp <ts>]
 *       [--samples <N=48>] [--tolerance <pct=0.5>] [--invariants-only]
 *       [--vault <address>]
 *
 * Note: the sampling error decreases with N. When a window exceeds the
 * tolerance, it is automatically re-sampled with 4x more steps before being
 * reported as an error — if the gap shrinks below tolerance, it was the
 * approximation; if it persists, it is a real computation discrepancy.
 *
 * Also exported as verifyDistribution() so main.ts can run it between the
 * distribution step (2) and the merkle generation (3).
 */

const DATA_DIR = path.resolve(__dirname, "../../data");
const FRACTION_SCALE = 10n ** 18n;

// ── Report ───────────────────────────────────────────────────────────

const errors: string[] = [];
const warnings: string[] = [];

const fail = (msg: string) => {
    errors.push(msg);
    console.error(`❌ ${msg}`);
};

const warn = (msg: string) => {
    warnings.push(msg);
    console.warn(`⚠️  ${msg}`);
};

// ── File loading (raw JSON.parse: amounts stay strings and are converted
//    explicitly, to avoid depending on safeParse) ──────────────────────

interface RawUser {
    user: string;
    balance: string;
    share: string;
    amount: string;
    source?: string;
}

interface RawIncentiveDistribution {
    vault: string;
    token: { address: string; decimals: number; symbol: string };
    distribution: { incentivePerSecond: string; amountToDistribute: string; incentiveId: number };
    users: RawUser[];
}

interface RawDistribution {
    blockNumber: number;
    timestamp: number;
    incentives: RawIncentiveDistribution[];
}

interface RawHolder {
    user: string;
    weight: string;
    sharePercentage: string;
}

interface RawGaugeWindow {
    incentiveId: number;
    startTimestamp: number;
    endTimestamp: number;
    holders: RawHolder[];
}

interface RawGaugeHolders {
    vault: string;
    windows: RawGaugeWindow[];
}

const readDistribution = (timestamp: number): RawDistribution | null => {
    const filePath = path.resolve(DATA_DIR, `distributions/${timestamp}/distribution.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, { encoding: "utf-8" })) as RawDistribution;
};

const readGaugeFiles = (timestamp: number): RawGaugeHolders[] => {
    const dir = path.resolve(DATA_DIR, `distributions/${timestamp}/gauges`);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.resolve(dir, f), { encoding: "utf-8" })) as RawGaugeHolders);
};

// ── Phase A: exact invariants ────────────────────────────────────────

const checkInvariants = async (timestamp: number, distribution: RawDistribution, gauges: RawGaugeHolders[]) => {
    console.log(`\n═══ Phase A: exact invariants (run ${timestamp}) ═══\n`);

    const incentivesDb = await getIncentives();
    const windowByIncentiveId = new Map<number, RawGaugeWindow>();
    for (const gauge of gauges) {
        for (const window of gauge.windows) {
            windowByIncentiveId.set(window.incentiveId, window);
        }
    }

    for (const inc of distribution.incentives) {
        const id = inc.distribution.incentiveId;
        const label = `incentive #${id} (${inc.token.symbol}, vault ${inc.vault})`;
        const amountToDistribute = BigInt(inc.distribution.amountToDistribute);
        const perSecond = BigInt(inc.distribution.incentivePerSecond);

        // A1 — user amounts must sum exactly (the last user absorbs the
        // division remainder, including after wrapper expansion)
        const sumUsers = inc.users.reduce((acc, u) => acc + BigInt(u.amount), 0n);
        if (sumUsers !== amountToDistribute) {
            fail(`A1 ${label}: sum of users ${sumUsers} != amountToDistribute ${amountToDistribute} (delta ${sumUsers - amountToDistribute})`);
        } else {
            console.log(`✅ A1 ${label}: sum of users == amountToDistribute (${amountToDistribute})`);
        }

        // A2 — the window amount matches rate * window duration
        const window = windowByIncentiveId.get(id);
        if (!window) {
            warn(`A2 ${label}: no window in gauges/ for this run`);
        } else {
            const elapsed = BigInt(window.endTimestamp - window.startTimestamp);
            const expected = perSecond * elapsed;
            if (expected !== amountToDistribute) {
                fail(`A2 ${label}: perSecond*elapsed ${expected} != amountToDistribute ${amountToDistribute}`);
            } else {
                console.log(`✅ A2 ${label}: amountToDistribute == perSecond * ${elapsed}s`);
            }
        }

        // A3 — the rate matches the recorded on-chain incentive
        const dbIncentive = incentivesDb.find((i) => i.id === id);
        if (!dbIncentive) {
            warn(`A3 ${label}: incentive missing from incentives.json`);
        } else {
            const duration = BigInt(dbIncentive.end) - BigInt(dbIncentive.start);
            const expectedPerSecond = duration > 0n ? BigInt(dbIncentive.amount) / duration : 0n;
            if (expectedPerSecond !== perSecond) {
                fail(`A3 ${label}: incentivePerSecond ${perSecond} != amount/duration ${expectedPerSecond}`);
            } else {
                console.log(`✅ A3 ${label}: incentivePerSecond == amount / total duration`);
            }
        }
    }

    // A4 — gauge snapshot shares must sum to ~100%
    for (const gauge of gauges) {
        for (const window of gauge.windows) {
            const sumShares = window.holders.reduce((acc, h) => acc + Number(h.sharePercentage), 0);
            // tolerance: truncation to 6 decimals per holder
            const maxRoundingError = window.holders.length * 1e-6;
            if (Math.abs(sumShares - 100) > maxRoundingError + 1e-9) {
                fail(`A4 vault ${gauge.vault} incentive #${window.incentiveId}: shares sum to ${sumShares.toFixed(6)}% != 100%`);
            } else {
                console.log(`✅ A4 vault ${gauge.vault} incentive #${window.incentiveId}: shares = ${sumShares.toFixed(6)}%`);
            }
        }
    }

    // A5 — cross-run: window continuity and total budget per incentive
    console.log(`\n─── A5: cross-run consistency (all distributions) ───\n`);

    const allRuns = getLastDistributionsData();
    const windowsPerIncentive = new Map<number, { run: number; start: number; end: number; amount: bigint }[]>();

    for (const run of allRuns) {
        const runTimestamp = Number(run.timestamp);
        const dist = readDistribution(runTimestamp);
        if (!dist) continue;

        const runWindows = new Map<number, RawGaugeWindow>();
        for (const gauge of readGaugeFiles(runTimestamp)) {
            for (const window of gauge.windows) runWindows.set(window.incentiveId, window);
        }

        for (const inc of dist.incentives) {
            const id = inc.distribution.incentiveId;
            const window = runWindows.get(id);
            if (!window) continue;
            const list = windowsPerIncentive.get(id) ?? [];
            list.push({
                run: runTimestamp,
                start: window.startTimestamp,
                end: window.endTimestamp,
                amount: BigInt(inc.distribution.amountToDistribute),
            });
            windowsPerIncentive.set(id, list);
        }
    }

    for (const [id, windows] of [...windowsPerIncentive.entries()].sort((a, b) => a[0] - b[0])) {
        windows.sort((a, b) => a.start - b.start);
        const dbIncentive = incentivesDb.find((i) => i.id === id);

        let overlaps = 0;
        let gaps = 0;
        for (let i = 1; i < windows.length; i++) {
            if (windows[i].start < windows[i - 1].end) {
                overlaps++;
                fail(`A5 incentive #${id}: window overlap — run ${windows[i].run} starts at ${windows[i].start} before the end ${windows[i - 1].end} of run ${windows[i - 1].run} (DOUBLE DISTRIBUTION)`);
            } else if (windows[i].start > windows[i - 1].end) {
                gaps++;
                warn(`A5 incentive #${id}: ${windows[i].start - windows[i - 1].end}s gap between runs ${windows[i - 1].run} and ${windows[i].run}`);
            }
        }

        const totalDistributed = windows.reduce((acc, w) => acc + w.amount, 0n);

        if (dbIncentive) {
            const start = Number(dbIncentive.start);
            const end = Number(dbIncentive.end);
            const duration = BigInt(end - start);
            const perSecond = duration > 0n ? BigInt(dbIncentive.amount) / duration : 0n;
            const budget = perSecond * duration; // <= amount (remainder = division dust)

            if (windows[0].start < start) {
                fail(`A5 incentive #${id}: first window (${windows[0].start}) before the incentive start (${start})`);
            }
            if (windows[windows.length - 1].end > end) {
                fail(`A5 incentive #${id}: last window (${windows[windows.length - 1].end}) after the incentive end (${end})`);
            }
            if (totalDistributed > budget) {
                fail(`A5 incentive #${id}: total distributed ${totalDistributed} > budget ${budget} (OVER-DISTRIBUTION)`);
            }
            if (dbIncentive.ended && totalDistributed < budget && overlaps === 0 && gaps === 0) {
                warn(`A5 incentive #${id}: ended but total distributed ${totalDistributed} < budget ${budget} (missing ${budget - totalDistributed})`);
            }
        }

        if (overlaps === 0) {
            console.log(`✅ A5 incentive #${id}: ${windows.length} window(s), no overlap, total distributed ${totalDistributed}${gaps > 0 ? ` (${gaps} gap(s))` : ""}`);
        }
    }
};

// ── Phase B: on-chain sampling (trapezoidal rule) ────────────────────

const BALANCE_BATCH_SIZE = 100;

const readBalancesAtBlock = async (
    client: any,
    token: Address,
    addresses: Address[],
    blockNumber: bigint,
): Promise<Map<Address, bigint>> => {
    const balances = new Map<Address, bigint>();
    for (let i = 0; i < addresses.length; i += BALANCE_BATCH_SIZE) {
        const batch = addresses.slice(i, i + BALANCE_BATCH_SIZE);
        const results = await client.multicall({
            contracts: batch.map((user) => ({
                address: token,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [user],
            })),
            blockNumber,
        });
        for (let j = 0; j < batch.length; j++) {
            if (results[j].status !== "success") {
                throw new Error(`balanceOf(${batch[j]}) failed at block ${blockNumber} for token ${token}`);
            }
            balances.set(batch[j], results[j].result as bigint);
        }
    }
    return balances;
};

const readTotalSupplyAtBlock = async (client: any, token: Address, blockNumber: bigint): Promise<bigint> => {
    return (await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "totalSupply",
        args: [],
        blockNumber,
    })) as bigint;
};

interface SampleData {
    timestamp: number;
    supply: bigint;
    balances: Map<Address, bigint>;
}

interface Offender {
    user: string;
    stored: number;
    approx: number;
    diff: number;
}

interface WindowReport {
    kind: "insufficient-samples" | "manager-fallback" | "zero-weights" | "compared";
    managerSuspect: boolean;
    maxMissingPct: number;
    offenders: Offender[];
    maxDiff: number;
}

// When a window exceeds the tolerance, re-sample with 4x more steps before
// reporting an error, to rule out trapezoidal approximation error
const ESCALATION_FACTOR = 4;

const sampleWindow = async (
    client: any,
    vault: Address,
    window: RawGaugeWindow,
    holderUnion: Address[],
    samplesPerWindow: number,
    tolerancePct: number,
    currentBlockNumber: bigint,
    tsCache: BlockTimestampCache,
    sampleCache: Map<string, SampleData>,
): Promise<WindowReport> => {
    const { startTimestamp, endTimestamp } = window;

    // "No holders" case: everything went to the manager (weight 0, share 100%)
    const isManagerFallback = window.holders.every((h) => BigInt(h.weight) === 0n);

    // 1. Resolve the sampling blocks
    const duration = endTimestamp - startTimestamp;
    const targets: number[] = [];
    for (let i = 0; i <= samplesPerWindow; i++) {
        targets.push(startTimestamp + Math.round((duration * i) / samplesPerWindow));
    }

    const blocks: bigint[] = [];
    let lowerBound = 0n;
    for (let i = 0; i < targets.length; i++) {
        const block =
            i === 0
                ? await blockAtOrAfter(client, targets[i], 0n, currentBlockNumber, tsCache)
                : await blockAtOrBefore(client, targets[i], lowerBound, currentBlockNumber, tsCache);
        const clamped = block < lowerBound ? lowerBound : block;
        blocks.push(clamped);
        lowerBound = clamped;
    }

    // 2. Read on-chain state at each block (balances + supply), memoized per vault
    const samples: SampleData[] = [];
    for (const block of blocks) {
        const key = block.toString();
        let sample = sampleCache.get(key);
        if (!sample) {
            const [balances, supply] = await Promise.all([
                readBalancesAtBlock(client, vault, holderUnion, block),
                readTotalSupplyAtBlock(client, vault, block),
            ]);
            sample = {
                timestamp: await getBlockTimestamp(client, block, tsCache),
                supply,
                balances,
            };
            sampleCache.set(key, sample);
        }
        if (samples.length === 0 || sample.timestamp > samples[samples.length - 1].timestamp) {
            samples.push(sample);
        }
    }

    if (samples.length < 2) {
        return { kind: "insufficient-samples", managerSuspect: false, maxMissingPct: 0, offenders: [], maxDiff: 0 };
    }

    // 3. Holder completeness: sum(balances) must cover totalSupply
    let maxMissingPct = 0;
    for (const sample of samples) {
        if (sample.supply === 0n) continue;
        const sumBalances = [...sample.balances.values()].reduce((a, b) => a + b, 0n);
        const missing = sample.supply - sumBalances;
        if (missing > 0n) {
            const missingPct = Number((missing * 1000000n) / sample.supply) / 10000;
            if (missingPct > maxMissingPct) maxMissingPct = missingPct;
        }
    }
    if (isManagerFallback) {
        const anySupply = samples.some((s) => s.supply > 0n);
        return { kind: "manager-fallback", managerSuspect: anySupply, maxMissingPct, offenders: [], maxDiff: 0 };
    }

    // 4. Trapezoidal integration of balance(t)/supply(t) for each holder
    const weights = new Map<Address, bigint>();
    for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i];
        const b = samples[i + 1];
        // Abscissas = actual block timestamps, clamped to the window
        const ta = Math.max(a.timestamp, startTimestamp);
        const tb = Math.min(b.timestamp, endTimestamp);
        const dt = BigInt(Math.max(tb - ta, 0));
        if (dt === 0n) continue;

        for (const user of holderUnion) {
            const fa = a.supply > 0n ? ((a.balances.get(user) ?? 0n) * FRACTION_SCALE) / a.supply : 0n;
            const fb = b.supply > 0n ? ((b.balances.get(user) ?? 0n) * FRACTION_SCALE) / b.supply : 0n;
            const area = ((fa + fb) * dt) / 2n;
            if (area > 0n) weights.set(user, (weights.get(user) ?? 0n) + area);
        }
    }

    const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0n);
    if (totalWeight === 0n) {
        return { kind: "zero-weights", managerSuspect: false, maxMissingPct, offenders: [], maxDiff: 0 };
    }

    // 5. Compare against the stored shares
    let maxDiff = 0;
    const offenders: Offender[] = [];

    const approxShare = (user: Address): number =>
        Number(((weights.get(user) ?? 0n) * 1000000n * 100n) / totalWeight) / 1000000;

    for (const holder of window.holders) {
        const stored = Number(holder.sharePercentage);
        const approx = approxShare(getAddress(holder.user));
        const diff = Math.abs(approx - stored);
        if (diff > maxDiff) maxDiff = diff;
        if (diff > tolerancePct) offenders.push({ user: holder.user, stored, approx, diff });
    }

    // Users detected by sampling but absent from the stored snapshot
    const storedUsers = new Set(window.holders.map((h) => getAddress(h.user)));
    for (const [user, weight] of weights.entries()) {
        if (storedUsers.has(user)) continue;
        const approx = Number((weight * 1000000n * 100n) / totalWeight) / 1000000;
        if (approx > tolerancePct) {
            offenders.push({ user, stored: 0, approx, diff: approx });
            if (approx > maxDiff) maxDiff = approx;
        }
    }

    return { kind: "compared", managerSuspect: false, maxMissingPct, offenders, maxDiff };
};

const verifyWindowBySampling = async (
    client: any,
    vault: Address,
    window: RawGaugeWindow,
    holderUnion: Address[],
    samplesPerWindow: number,
    tolerancePct: number,
    currentBlockNumber: bigint,
    tsCache: BlockTimestampCache,
    sampleCache: Map<string, SampleData>,
) => {
    const label = `vault ${vault} incentive #${window.incentiveId} [${window.startTimestamp} → ${window.endTimestamp}]`;

    let usedSamples = samplesPerWindow;
    let report = await sampleWindow(
        client, vault, window, holderUnion, usedSamples, tolerancePct, currentBlockNumber, tsCache, sampleCache,
    );

    // Escalation: a legit mid-window balance move can push a user out of
    // tolerance by pure approximation error — re-sample before failing
    if (report.kind === "compared" && report.offenders.length > 0) {
        usedSamples = samplesPerWindow * ESCALATION_FACTOR;
        console.log(`↻  B ${label}: ${report.offenders.length} user(s) out of tolerance at ${samplesPerWindow} steps — re-sampling with ${usedSamples} steps`);
        report = await sampleWindow(
            client, vault, window, holderUnion, usedSamples, tolerancePct, currentBlockNumber, tsCache, sampleCache,
        );
    }

    if (report.maxMissingPct > tolerancePct) {
        fail(`B ${label}: up to ${report.maxMissingPct.toFixed(4)}% of the supply belongs to no known holder (holders missed by the scan?)`);
    } else if (report.maxMissingPct > 0) {
        console.log(`ℹ️  B ${label}: at most ${report.maxMissingPct.toFixed(4)}% of supply outside known holders (within tolerance)`);
    }

    switch (report.kind) {
        case "insufficient-samples":
            warn(`B ${label}: fewer than 2 distinct samples (window too short / identical blocks), verification impossible`);
            break;
        case "manager-fallback":
            if (report.managerSuspect) {
                warn(`B ${label}: manager fallback (100% to the manager) but the sampled supply is > 0 — check manually`);
            } else {
                console.log(`✅ B ${label}: manager fallback confirmed (zero supply across the whole window)`);
            }
            break;
        case "zero-weights":
            warn(`B ${label}: all sampled weights are zero although the distribution has holders`);
            break;
        case "compared":
            if (report.offenders.length > 0) {
                fail(`B ${label}: ${report.offenders.length} user(s) out of tolerance at ${usedSamples} steps (max gap ${report.maxDiff.toFixed(4)} pts)`);
                for (const o of report.offenders.sort((a, b) => b.diff - a.diff).slice(0, 5)) {
                    console.error(`     ${o.user}: stored ${o.stored.toFixed(6)}% vs sampled ${o.approx.toFixed(6)}% (gap ${o.diff.toFixed(4)})`);
                }
            } else {
                console.log(`✅ B ${label}: ${window.holders.length} holder(s), max gap ${report.maxDiff.toFixed(4)} pts (tolerance ${tolerancePct}, ${usedSamples} steps)`);
            }
            break;
    }
};

const checkBySampling = async (
    timestamp: number,
    gauges: RawGaugeHolders[],
    samplesPerWindow: number,
    tolerancePct: number,
    vaultFilter?: string,
) => {
    if (vaultFilter) {
        gauges = gauges.filter((g) => getAddress(g.vault) === getAddress(vaultFilter));
    }
    console.log(`\n═══ Phase B: on-chain sampling (${samplesPerWindow} steps, tolerance ${tolerancePct} pts) ═══\n`);

    const client = await getClient(mainnet.id);
    const currentBlockNumber = await client.getBlockNumber();
    const tsCache: BlockTimestampCache = new Map();

    for (const gauge of gauges) {
        const vault = getAddress(gauge.vault) as Address;

        // Union of holders across all windows of the vault: lets us memoize
        // per-block reads when windows overlap
        const holderUnion = [
            ...new Set(gauge.windows.flatMap((w) => w.holders.map((h) => getAddress(h.user) as Address))),
        ];
        const sampleCache = new Map<string, SampleData>();

        for (const window of gauge.windows) {
            await verifyWindowBySampling(
                client,
                vault,
                window,
                holderUnion,
                samplesPerWindow,
                tolerancePct,
                currentBlockNumber,
                tsCache,
                sampleCache,
            );
        }
    }
};

// ── Main ─────────────────────────────────────────────────────────────

const parseArgs = () => {
    const args = process.argv.slice(2);
    const get = (flag: string): string | undefined => {
        const idx = args.indexOf(flag);
        return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
    };
    return {
        timestamp: get("--timestamp") ? Number(get("--timestamp")) : undefined,
        samples: Number(get("--samples") ?? 48),
        tolerance: Number(get("--tolerance") ?? 0.5),
        invariantsOnly: args.includes("--invariants-only"),
        vault: get("--vault"),
    };
};

export interface VerifyDistributionOptions {
    timestamp?: number;
    samples?: number;
    tolerance?: number;
    invariantsOnly?: boolean;
    vault?: string;
}

export interface VerifyDistributionResult {
    timestamp: number;
    errors: string[];
    warnings: string[];
}

export const verifyDistribution = async (
    options: VerifyDistributionOptions = {},
): Promise<VerifyDistributionResult> => {
    // Reset the module-level report so repeated calls start clean
    errors.length = 0;
    warnings.length = 0;

    const samples = options.samples ?? 48;
    const tolerance = options.tolerance ?? 0.5;

    const allRuns = getLastDistributionsData();
    if (allRuns.length === 0) throw new Error("No distribution in data/distribution.json");

    const timestamp = options.timestamp ?? Number(allRuns[allRuns.length - 1].timestamp);
    console.log(`🔍 Verifying distribution ${timestamp}`);

    const distribution = readDistribution(timestamp);
    if (!distribution) throw new Error(`data/distributions/${timestamp}/distribution.json not found`);
    const gauges = readGaugeFiles(timestamp);

    await checkInvariants(timestamp, distribution, gauges);

    if (!options.invariantsOnly) {
        await checkBySampling(timestamp, gauges, samples, tolerance, options.vault);
    }

    console.log(`\n═══ Summary ═══`);
    console.log(`   Errors    : ${errors.length}`);
    console.log(`   Warnings  : ${warnings.length}`);

    return { timestamp, errors: [...errors], warnings: [...warnings] };
};

const main = async () => {
    const result = await verifyDistribution(parseArgs());

    if (result.errors.length > 0) {
        console.error(`\n🚨 FAILURE: distribution ${result.timestamp} has inconsistencies.`);
        process.exit(1);
    }
    console.log(`\n✨ SUCCESS: distribution ${result.timestamp} verified.`);
};

if (require.main === module) {
    main().catch((err) => {
        console.error("❌ Verification failed:", err);
        process.exit(1);
    });
}
