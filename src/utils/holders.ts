import fs from 'fs';
import path from 'path';
import { safeParse, safeStringify } from './parse';
import { Address } from 'viem';

export interface HolderData {
  blockNumber: number;
  users: Address[];
}

const getHoldersDir = (vault: string): string => {
  return path.resolve(__dirname, `../../data/holders/${vault}`);
};

const getHoldersPath = (vault: string): string => {
  const dir = getHoldersDir(vault);
  return path.resolve(dir, `index.json`);
};

export const getHolders = (vault: string): HolderData => {
  // Load the canonical distribution.json (for a timestamp)
  const dir = getHoldersDir(vault);
  if(!fs.existsSync(dir)) {
    return {blockNumber: 0, users:[]};
  }
  
  return safeParse(fs.readFileSync(getHoldersPath(vault), { encoding: 'utf-8' })) as HolderData;
};

export const writeHolders = (vault: string, data: HolderData) => {
  const dir = getHoldersDir(vault);
  if(!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const filePath = getHoldersPath(vault);
  fs.writeFileSync(filePath, safeStringify(data), { encoding: 'utf-8' });
};