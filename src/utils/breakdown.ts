import path from 'path';
import fs from 'fs';
import { safeParse, safeStringify } from './parse';
import { getAddress } from 'viem';
import { Breakdown, BreakdownMeta, EarnedSource, SerializedEarnedEntry, SerializedClaimEvent, VaultTokenBreakdown } from '../interfaces/Breakdown';
import { UserDistribution } from '../interfaces/Distribution';

const BREAKDOWN_DIR = path.resolve(__dirname, '../../data/breakdown');

const ensureDir = () => {
    if (!fs.existsSync(BREAKDOWN_DIR)) {
        fs.mkdirSync(BREAKDOWN_DIR, { recursive: true });
    }
};

const metaPath = () => path.resolve(BREAKDOWN_DIR, 'meta.json');
const earnedPath = () => path.resolve(BREAKDOWN_DIR, 'earned.json');
const claimsPath = () => path.resolve(BREAKDOWN_DIR, 'claims.json');
const breakdownPath = () => path.resolve(BREAKDOWN_DIR, 'breakdown.json');

export function earnedPortions(user: UserDistribution, morphoDepositors: ReadonlySet<string>): { amount: bigint; source: EarnedSource }[] {
    const amount = BigInt(user.amount);
    // Old files omit source. Only wrapper-only Morpho positions had zero TWAB.
    const source = user.source ?? (
        BigInt(user.balance) === 0n && morphoDepositors.has(getAddress(user.user).toLowerCase()) ? 'morpho' : 'direct'
    );
    if (!user.firmEscrows?.length) return [{ amount, source }];

    const firm = user.firmEscrows.reduce((sum, escrow) => sum + BigInt(escrow.amount), 0n);
    if (firm > amount || (source === 'firm' && amount !== firm)) {
        throw new Error(`FiRM allocations do not reconcile for ${user.user}`);
    }
    if (firm === amount) return [{ amount, source: 'firm' }];
    if (firm === 0n) return [{ amount, source }];
    return [{ amount: amount - firm, source }, { amount: firm, source: 'firm' }];
}

export function describeSources(sources: ReadonlySet<EarnedSource>): Pick<VaultTokenBreakdown, 'type' | 'sources'> {
    if (sources.size < 2) return { type: sources.values().next().value ?? 'direct' };
    if (sources.has('firm')) return { type: 'both', sources: [...sources].sort() };
    return { type: 'both' };
}

// ── Meta (incremental state) ──

export const emptyMeta = (): BreakdownMeta => ({
    lastProcessedTimestamp: 0,
    lastScannedBlock: 0,
});

export const readMeta = (): BreakdownMeta => {
    const p = metaPath();
    if (!fs.existsSync(p)) return emptyMeta();
    return safeParse(fs.readFileSync(p, { encoding: 'utf-8' })) as BreakdownMeta;
};

export const writeMeta = (meta: BreakdownMeta): void => {
    ensureDir();
    fs.writeFileSync(metaPath(), safeStringify(meta), { encoding: 'utf-8' });
};

// ── Earned entries ──

export const readEarnedEntries = (): Record<string, SerializedEarnedEntry[]> => {
    const p = earnedPath();
    if (!fs.existsSync(p)) return {};
    return safeParse(fs.readFileSync(p, { encoding: 'utf-8' })) as Record<string, SerializedEarnedEntry[]>;
};

export const writeEarnedEntries = (entries: Record<string, SerializedEarnedEntry[]>): void => {
    ensureDir();
    fs.writeFileSync(earnedPath(), safeStringify(entries), { encoding: 'utf-8' });
    console.log(`💾 Earned entries saved to ${earnedPath()}`);
};

// ── Claim events ──

export const readClaimEvents = (): Record<string, SerializedClaimEvent[]> => {
    const p = claimsPath();
    if (!fs.existsSync(p)) return {};
    return safeParse(fs.readFileSync(p, { encoding: 'utf-8' })) as Record<string, SerializedClaimEvent[]>;
};

export const writeClaimEvents = (events: Record<string, SerializedClaimEvent[]>): void => {
    ensureDir();
    fs.writeFileSync(claimsPath(), safeStringify(events), { encoding: 'utf-8' });
    console.log(`💾 Claim events saved to ${claimsPath()}`);
};

// ── Breakdown (the UI-facing file) ──

export const writeBreakdown = (breakdown: Breakdown): void => {
    ensureDir();
    fs.writeFileSync(breakdownPath(), safeStringify(breakdown), { encoding: 'utf-8' });
    console.log(`💾 Breakdown saved to ${breakdownPath()}`);
};
