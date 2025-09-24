import path from 'path';
import fs from 'fs';
import { safeParse, safeStringify } from './parse';
import { IncentiveExtended } from '../interfaces/IncentiveExtended';

const getIncentivesPath = (): string => {
    return path.resolve(__dirname, "../../data/incentives.json");
}

export const getIncentives = async () => {
    const path = getIncentivesPath();
    if (!fs.existsSync(path)) {
        return [];
    }

    return safeParse(fs.readFileSync(getIncentivesPath(), { encoding: 'utf-8' })) as IncentiveExtended[];
}

export const writeIncentives = (incentives: IncentiveExtended[]) => {
    const path = getIncentivesPath();
    fs.writeFileSync(path, safeStringify(incentives), { encoding: 'utf-8' });
    console.log(`💾 Incentives saved to ${path}`);
}