import path from 'path';
import fs from 'fs';
import { safeParse, safeStringify } from './parse';
import { IncentiveExtended } from '../interfaces/IncentiveExtended';

const getIncentivesDir = (chainId): string => {
    return path.resolve(__dirname, `../../data${chainId !== 1 ? `/${chainId}` : ''}`);
}

const getIncentivesPath = (chainId): string => {
    const dir = getIncentivesDir(chainId);
    return path.resolve(dir, `incentives.json`);
}

export const getIncentives = async (chainId) => {
    const path = getIncentivesPath(chainId);
    if (!fs.existsSync(path)) {
        return [];
    }

    return safeParse(fs.readFileSync(getIncentivesPath(chainId), { encoding: 'utf-8' })) as IncentiveExtended[];
}

export const writeIncentives = (incentives: IncentiveExtended[], chainId) => {
    
    const dir = getIncentivesDir(chainId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const path = getIncentivesPath(chainId);
    fs.writeFileSync(path, safeStringify(incentives), { encoding: 'utf-8' });
    console.log(`💾 Incentives saved to ${path}`);
}