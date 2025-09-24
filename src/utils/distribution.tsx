import fs from 'fs';
import path from 'path';
import { Distribution } from '../interfaces/Distribution';
import { safeParse, safeStringify } from './parse';
import { GaugeHolders } from '../interfaces/GaugeHolders';

const getDistributionDirPath = (timestamp: number): string => {
  return path.resolve(__dirname, `../data/distributions/${timestamp}`);
};

const getDistributionPath = (timestamp: number): string => {
  const dir = getDistributionDirPath(timestamp);
  return path.resolve(dir, `distribution.json`);
};

export const rmAndCreateDistributionDir = (timestamp: number) => {
  // Re-create a clean folder for a given distribution timestamp
  const dir = getDistributionDirPath(timestamp);

  if (fs.existsSync(dir)) {
    // Remove recursively to avoid EEXIST on non-empty directories
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`🧹 Removed existing dir for ${timestamp}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  console.log(`📁 Created dir for ${timestamp}`);
};

export const writeDistributionGaugeData = (timestamp: number, gaugeHolders: GaugeHolders) => {
  // Store per-gauge holders snapshot for this distribution
  // (no leading slash in the second arg, keep it relative)
  const gaugePath = path.resolve(getDistributionDirPath(timestamp), `gauges/${gaugeHolders.vault}.json`);
  fs.mkdirSync(path.dirname(gaugePath), { recursive: true });
  fs.writeFileSync(gaugePath, safeStringify(gaugeHolders), { encoding: 'utf-8' });
  console.log(`🧾 Gauge file written (vault=${gaugeHolders.vault})`);
};

export const getDistribution = (timestamp: number): Distribution => {
  // Load the canonical distribution.json (for a timestamp)
  const filePath = getDistributionPath(timestamp);
  const dist = safeParse(fs.readFileSync(filePath, { encoding: 'utf-8' })) as Distribution;
  console.log(`📖 Loaded distribution (timestamp=${timestamp}, incentives=${dist.incentives.length})`);
  return dist;
};

export const writeDistribution = (currentDistribution: Distribution) => {
  // Persist the canonical distribution.json
  const filePath = getDistributionPath(currentDistribution.timestamp);
  fs.writeFileSync(filePath, safeStringify(currentDistribution), { encoding: 'utf-8' });
  console.log(`💾 Distribution saved to ${filePath}`);
};