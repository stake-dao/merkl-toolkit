import fs from 'fs';
import path from 'path';
import { safeParse, safeStringify } from './parse';
import { Address } from 'viem';

export interface HolderData {
  blockNumber: number;
  users: Address[];
}

const getHoldersDir = (vault: string, chainId: number): string => {
  return path.resolve(__dirname, `../../data${chainId !== 1 ? `/${chainId}` : ''}/holders/${vault}`);
};

const getHoldersPath = (vault: string, chainId: number): string => {
  const dir = getHoldersDir(vault, chainId);
  return path.resolve(dir, `index.json`);
};

export const getHolders = (vault: string, chainId: number): HolderData => {
  // Load the canonical distribution.json (for a timestamp)
  const dir = getHoldersDir(vault, chainId);
  if(!fs.existsSync(dir)) {
    return {blockNumber: 0, users:[]};
  }
  
  return safeParse(fs.readFileSync(getHoldersPath(vault, chainId), { encoding: 'utf-8' })) as HolderData;
};

export const writeHolders = (vault: string, data: HolderData, chainId: number) => {
  const dir = getHoldersDir(vault, chainId);
  if(!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const filePath = getHoldersPath(vault, chainId);
  fs.writeFileSync(filePath, safeStringify(data), { encoding: 'utf-8' });
};