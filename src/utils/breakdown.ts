import path from 'path';
import fs from 'fs';
import { safeParse, safeStringify } from './parse';
import { Breakdown, BreakdownMeta, SerializedEarnedEntry, SerializedClaimEvent } from '../interfaces/Breakdown';

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
