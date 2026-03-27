import path from 'path';
import fs from 'fs';
import { safeParse, safeStringify } from './parse';
import { BreakdownFile } from '../interfaces/Breakdown';

const getBreakdownPath = (): string => {
    return path.resolve(__dirname, '../../data/last_breakdown.json');
};

export const emptyBreakdownFile = (): BreakdownFile => ({
    lastProcessedTimestamp: 0,
    lastScannedBlock: 0,
    earnedEntries: {},
    claimEvents: {},
    breakdown: {},
});

export const getBreakdownFile = (): BreakdownFile => {
    const p = getBreakdownPath();
    if (!fs.existsSync(p)) return emptyBreakdownFile();
    return safeParse(fs.readFileSync(p, { encoding: 'utf-8' })) as BreakdownFile;
};

export const writeBreakdownFile = (file: BreakdownFile): void => {
    const p = getBreakdownPath();
    fs.writeFileSync(p, safeStringify(file), { encoding: 'utf-8' });
    console.log(`💾 Breakdown saved to ${p}`);
};
