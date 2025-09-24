import path from 'path';
import fs from 'fs';
import { safeParse, safeStringify } from './parse';
import { DistributionData } from '../interfaces/DistributionData';

const getDistributionsDataPath = (): string => {
    return path.resolve(__dirname, "../data/distribution.json");
}

export const getLastDistributionsData = (): DistributionData[] => {
    const path = getDistributionsDataPath();
    if (!fs.existsSync(path)) {
        return [];
    }

    return safeParse(fs.readFileSync(getDistributionsDataPath(), { encoding: 'utf-8' })) as DistributionData[];
}

export const writeLastDistributionData = (distribution: DistributionData) => {
    const lastDistributions = getLastDistributionsData();
    lastDistributions.push(distribution);

    fs.writeFileSync(getDistributionsDataPath(), safeStringify(lastDistributions), { encoding: 'utf-8' });
}