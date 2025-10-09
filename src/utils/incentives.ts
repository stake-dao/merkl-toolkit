import path from 'path';
import fs from 'fs';
import { safeParse, safeStringify } from './parse';
import { IncentiveExtended } from '../interfaces/IncentiveExtended';

const getIncentivesDir = (): string => {
    return path.resolve(__dirname, "../../data");
}

const getIncentivesPath = (): string => {
    const dir = getIncentivesDir();
    return path.resolve(dir, `incentives.json`);
}

export const getIncentives = async () => {
    const path = getIncentivesPath();
    if (!fs.existsSync(path)) {
        return [];
    }

    return safeParse(fs.readFileSync(getIncentivesPath(), { encoding: 'utf-8' })) as IncentiveExtended[];
}

export const writeIncentives = (incentives: IncentiveExtended[]) => {
    
    const dir = getIncentivesDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const path = getIncentivesPath();
    fs.writeFileSync(path, safeStringify(incentives), { encoding: 'utf-8' });
    console.log(`💾 Incentives saved to ${path}`);
}