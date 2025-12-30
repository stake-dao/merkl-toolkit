import path from 'path';
import fs from 'fs';
import { safeParse, safeStringify } from './parse';
import { DistributionData } from '../interfaces/DistributionData';

const getDistributionsDataPath = (chainId: number): string => {
    return path.resolve(__dirname, `../../data${chainId !== 1 ? `/${chainId}` : ''}/distribution.json`);
}

export const getLastDistributionsData = (chainId: number): DistributionData[] => {
    const path = getDistributionsDataPath(chainId);
    if (!fs.existsSync(path)) {
        return [];
    }

    return safeParse(fs.readFileSync(getDistributionsDataPath(chainId), { encoding: 'utf-8' })) as DistributionData[];
}

export const writeLastDistributionData = (distribution: DistributionData, chainId: number) => {
    const lastDistributions = getLastDistributionsData(chainId);
    lastDistributions.push(distribution);

    fs.writeFileSync(getDistributionsDataPath(chainId), safeStringify(lastDistributions), { encoding: 'utf-8' });
}

export const overideDistributionData = (distributions: DistributionData[], chainId: number) => {
    fs.writeFileSync(getDistributionsDataPath(chainId), safeStringify(distributions), { encoding: 'utf-8' });
}