import path from 'path';
import fs from 'fs';
import { safeParse, safeStringify } from './parse';
import { UniversalMerkle } from '../interfaces/UniversalMerkle';
import { getAddress, keccak256 } from 'viem';
import { MerkleData } from '../interfaces/MerkleData';
import { utils } from "ethers";
import MerkleTree from 'merkletreejs';
import { Distribution } from '../interfaces/Distribution';

const getMerklePath = (timestamp: number, chainId:number): string => {
    return path.resolve(__dirname, `../../data${chainId !== 1 ? `/${chainId}` : ''}/distributions/${timestamp}/merkle.json`);
}

export const getMerkle = (timestamp: number, chainId: number): MerkleData => {
    return safeParse(fs.readFileSync(getMerklePath(timestamp, chainId), { encoding: 'utf-8' })) as MerkleData;
}

export const writeMerkle = (timestamp: number, merkle: MerkleData, chainId: number) => {
    const path = getMerklePath(timestamp, chainId);
    fs.writeFileSync(path, safeStringify(merkle), { encoding: 'utf-8' });
    console.log(`💾 Merkle saved to ${path}`);
}

export const writeLastMerkle = (merkle: MerkleData, chainId: number) => {

    fs.writeFileSync(
        path.resolve(__dirname, `../../data${chainId !== 1 ? `/${chainId}` : ''}/last_merkle.json`)
        , safeStringify(merkle),
        { encoding: 'utf-8' }
    );
    console.log(`💾 Merkle saved globaly`);
}

export const createCombineDistribution = (
    currentDistribution: Distribution,
    previousMerkleData: MerkleData
): UniversalMerkle => {

    // Convert distribution to merkle format
    const merkleDistribution: { [address: string]: { [tokenAddress: string]: string } } = {};
    for(const incentive of currentDistribution.incentives) {
        const tokenChecksum = getAddress(incentive.token.address);

        for(const user of incentive.users) {
            const userChecksum = getAddress(user.user);
            if(!merkleDistribution[userChecksum]) {
             merkleDistribution[userChecksum] = {};   
            }

            if(!merkleDistribution[userChecksum][tokenChecksum]) {
                merkleDistribution[userChecksum][tokenChecksum] = '0';
            }

            merkleDistribution[userChecksum][tokenChecksum] = (BigInt(merkleDistribution[userChecksum][tokenChecksum]) + BigInt(user.amount)).toString();
        }
    }

    // First normalize the merkleDistribution addresses
    const normalizedMerkleDistribution: UniversalMerkle = {};

    // Normalize the new distribution first
    Object.entries(merkleDistribution).forEach(([address, tokens]) => {
        const normalizedAddress = getAddress(address);
        normalizedMerkleDistribution[normalizedAddress] = {};

        // Normalize and merge token amounts for the same address
        Object.entries(tokens).forEach(([tokenAddress, amount]) => {
            const normalizedTokenAddress = getAddress(tokenAddress);
            const currentAmount = BigInt(
                normalizedMerkleDistribution[normalizedAddress][
                normalizedTokenAddress
                ] || "0"
            );
            const newAmount = BigInt(amount);
            normalizedMerkleDistribution[normalizedAddress][
                normalizedTokenAddress
            ] = (currentAmount + newAmount).toString();
        });
    });

    // Then merge with previous merkle data
    if (previousMerkleData && previousMerkleData.claims) {
        Object.entries(previousMerkleData.claims).forEach(
            ([address, claimData]) => {
                const userNormalizedAddress = getAddress(address);

                if (!normalizedMerkleDistribution[userNormalizedAddress]) {
                    normalizedMerkleDistribution[userNormalizedAddress] = {};
                }

                if (claimData && claimData.tokens) {
                    Object.entries(claimData.tokens).forEach(
                        ([tokenAddress, tokenData]: [string, any]) => {
                            const normalizedTokenAddress = getAddress(tokenAddress);
                            const prevAmount = BigInt(tokenData.amount || "0");
                            const currentAmount = BigInt(
                                normalizedMerkleDistribution[userNormalizedAddress][
                                normalizedTokenAddress
                                ] || "0"
                            );

                            normalizedMerkleDistribution[userNormalizedAddress][
                                normalizedTokenAddress
                            ] = (prevAmount + currentAmount).toString();
                        }
                    );
                }
            }
        );
    }

    return normalizedMerkleDistribution;
}

export function generateMerkleTree(distribution: UniversalMerkle): MerkleData {
    const leaves: string[] = [];
    const claims: MerkleData["claims"] = {};

    // Convert input addresses to checksum addresses and merge duplicate addresses
    const checksummedDistribution = Object.entries(distribution).reduce(
        (acc, [address, tokens]) => {
            const checksumAddress = getAddress(address);

            // Initialize or merge with existing tokens for this address
            if (!acc[checksumAddress]) {
                acc[checksumAddress] = {};
            }

            // Merge tokens for this address
            Object.entries(tokens).forEach(([tokenAddress, amount]) => {
                const checksumTokenAddress = getAddress(tokenAddress);
                acc[checksumAddress][checksumTokenAddress] = amount;
            });

            return acc;
        },
        {} as { [address: string]: { [tokenAddress: string]: string } }
    );

    Object.entries(checksummedDistribution).forEach(([address, tokens]) => {
        Object.entries(tokens).forEach(([tokenAddress, amount]) => {
            const leaf = utils.keccak256(
                utils.solidityPack(
                    ["bytes"],
                    [
                        utils.keccak256(
                            utils.defaultAbiCoder.encode(
                                ["address", "address", "uint256"],
                                [address, tokenAddress, amount]
                            )
                        ),
                    ]
                )
            );
            leaves.push(leaf);

            if (!claims[address]) {
                claims[address] = { tokens: {} };
            }
            claims[address].tokens[tokenAddress] = {
                amount,
                proof: [],
            };
        });
    });

    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const merkleRoot = merkleTree.getHexRoot();

    // Generate proofs using checksummed addresses
    Object.entries(claims).forEach(([address, claim]) => {
        Object.entries(claim.tokens).forEach(([tokenAddress, tokenClaim]) => {
            const leaf = utils.keccak256(
                utils.solidityPack(
                    ["bytes"],
                    [
                        utils.keccak256(
                            utils.defaultAbiCoder.encode(
                                ["address", "address", "uint256"],
                                [address, tokenAddress, tokenClaim.amount]
                            )
                        ),
                    ]
                )
            );
            tokenClaim.proof = merkleTree.getHexProof(leaf);
        });
    });

    return { merkleRoot, claims };
}