import fs from 'fs';
import path from 'path';
import { Distribution } from '../interfaces/Distribution';
import { safeParse, safeStringify } from './parse';
import { GaugeHolders } from '../interfaces/GaugeHolders';

const getDistributionDirPath = (timestamp: number): string => {
    return path.resolve(__dirname, `../data/distributions/${timestamp}`);
}

const getDistributionPath = (timestamp: number): string => {
    const dir = getDistributionDirPath(timestamp);
    return path.resolve(dir, `distribution.json`);
}

export const rmAndCreateDistributionDir = (timestamp: number) => {
    const distributionPath = getDistributionDirPath(timestamp);
    if (fs.existsSync(distributionPath)) {
        fs.rmdirSync(distributionPath)
    }

    fs.mkdirSync(distributionPath, { recursive: true });
}

export const writeDistributionGaugeData = (timestamp: number, gaugeHolders: GaugeHolders) => {
    const gaugePath = path.resolve(getDistributionDirPath(timestamp), `/gauges/${gaugeHolders.vault}.json`)
    fs.writeFileSync(gaugePath, safeStringify(gaugeHolders), { encoding: 'utf-8' });
}

export const getDistribution = (timestamp: number): Distribution => {
    return safeParse(fs.readFileSync(getDistributionPath(timestamp), { encoding: 'utf-8' })) as Distribution;
}

export const writeDistribution = (currentDistribution: Distribution) => {
    fs.writeFileSync(getDistributionPath(currentDistribution.timestamp), safeStringify(currentDistribution), { encoding: 'utf-8' });
    console.log(`💾 Distribution saved to ${path}`);
}