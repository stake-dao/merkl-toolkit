import { Address, createPublicClient, extractChain, getAddress, http, parseAbi } from "viem";
import * as chains from "viem/chains";

const erc20Abi = parseAbi([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)',
]);

export class TokenHolderScanner {
    private client: any;
    private tokenAddress: Address;
    private chainId: string;

    constructor(rpcUrl: string, tokenAddress: Address, chainid: number) {
        this.client = createPublicClient({
            chain: extractChain({chains: Object.values(chains), id: chainid as any}),
            transport: http(rpcUrl),
        });
        this.tokenAddress = tokenAddress;
        this.chainId = chainid.toString();
    }

    /**
     * Helper: fetch with retry and rate limit handling
     */
    private async fetchWithRetry(
        url: string,
        maxRetries: number = 50,
        baseDelay: number = 1000
    ): Promise<any> {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(url);

                if (response.status === 429) {
                    const retryDelay = baseDelay * Math.pow(2, attempt);
                    console.log(`⏳ Rate limit hit, retrying in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data: any = await response.json();

                if (data.status === '0' && data.message && data.message.includes('rate limit')) {
                    const retryDelay = baseDelay * Math.pow(2, attempt);
                    console.log(`⏳ Etherscan rate limit detected, retrying in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }

                return data;

            } catch (error) {
                const isLastAttempt = attempt === maxRetries - 1;

                if (isLastAttempt) {
                    console.error(`❌ Failed after ${maxRetries} attempts:`, error);
                    throw error;
                }

                const retryDelay = baseDelay * Math.pow(2, attempt);
                console.log(`⚠️  Network error, retrying in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }

        throw new Error(`Failed after ${maxRetries} attempts`);
    }

    async getHoldersViaEtherscan(
        apiKey: string,
        tokenAddress: Address,
        fromBlock: bigint,
        targetBlock: bigint
    ): Promise<Address[]> {
        console.log('📊 Fetching holders via Etherscan API v2...');

        const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        const uniqueAddresses = new Set<Address>();

        const toBlock = targetBlock;
        const maxPageSize = BigInt(1000);
        const step = BigInt(10000);

        const fetchLogsRange = async (from: bigint, to: bigint) => {
            let page = 1;
            const pageSize = Number(maxPageSize);
            let hasMore = true;

            while (hasMore) {
                const url = `https://api.etherscan.io/v2/api?chainid=${this.chainId}&module=logs&action=getLogs&address=${tokenAddress}&topic0=${transferTopic}&fromBlock=${from}&toBlock=${to}&page=${page}&offset=${pageSize}&apikey=${apiKey}`;

                console.log(`🔹 Fetching blocks ${from} → ${to} (page ${page})...`);

                const data = await this.fetchWithRetry(url);

                if (
                    data.status === '0' &&
                    data.message &&
                    data.message.includes('Result window is too large')
                ) {
                    const mid = from + ((to - from) / BigInt(2));
                    console.log(`⚠️ Window too large (${from}-${to}), splitting into smaller ranges...`);
                    await fetchLogsRange(from, mid);
                    await fetchLogsRange(mid + BigInt(1), to);
                    return;
                }

                if (data.status !== '1' || !data.result || data.result.length === 0) {
                    hasMore = false;
                    await new Promise(resolve => setTimeout(resolve, 250));
                    break;
                }

                for (const log of data.result) {
                    const topics = log.topics;
                    if (topics.length >= 3 && topics[0].toLowerCase() === transferTopic.toLowerCase()) {
                        const fromAddr = getAddress('0x' + topics[1].slice(26));
                        const toAddr = getAddress('0x' + topics[2].slice(26));
                        uniqueAddresses.add(fromAddr);
                        uniqueAddresses.add(toAddr);
                    }
                }

                if (data.result.length < pageSize) {
                    hasMore = false;
                } else {
                    page++;
                }

                await new Promise(resolve => setTimeout(resolve, 250));
            }
        };

        for (let start = fromBlock; start <= toBlock; start += step) {
            const end = start + step - BigInt(1) > toBlock ? toBlock : start + step - BigInt(1);
            await fetchLogsRange(start, end);
        }

        console.log(`✅ ${uniqueAddresses.size} unique addresses found`);

        return Array.from(uniqueAddresses);
    }

    /**
     * Get balances for all addresses at a specific block
     */
    public async getBalancesAtBlock(
        addresses: Address[],
        blockNumber: bigint
    ): Promise<Map<Address, bigint>> {
        console.log(`💰 Fetching balances at block ${blockNumber}...`);

        const holders = new Map<Address, bigint>();
        const zeroAddress = '0x0000000000000000000000000000000000000000' as Address;

        const validAddresses = addresses.filter(addr => addr !== zeroAddress);

        const batchSize = 100;
        for (let i = 0; i < validAddresses.length; i += batchSize) {
            const batch = validAddresses.slice(i, i + batchSize);

            const contracts = batch.map(address => ({
                address: this.tokenAddress,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [address],
            }));

            try {
                const results = await this.client.multicall({
                    contracts,
                    blockNumber,
                });

                for (let j = 0; j < batch.length; j++) {
                    const result = results[j];
                    if (result.status === 'success' && result.result) {
                        const balance = BigInt(result.result);
                        if (balance > BigInt(0)) {
                            holders.set(batch[j], balance);
                        }
                    }
                }
            } catch (error) {
                console.error(`Error in batch ${i}-${i + batchSize}:`, error);
                for (const address of batch) {
                    try {
                        const balance = await this.client.readContract({
                            address: this.tokenAddress,
                            abi: erc20Abi,
                            functionName: 'balanceOf',
                            args: [address],
                            blockNumber,
                        });

                        if (balance > BigInt(0)) {
                            holders.set(address, balance);
                        }
                    } catch (err) {
                        console.error(`Error fetching balance for ${address}:`, err);
                    }
                }
            }

            console.log(`Progress: ${Math.min(i + batchSize, validAddresses.length)}/${validAddresses.length}`);
        }

        return holders;
    }
}