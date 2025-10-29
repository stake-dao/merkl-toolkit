import fs from "fs";
import path from "path";
import { Address, getAddress } from "viem";

import { writeIncentives } from "../utils/incentives";
import { overideDistributionData, getLastDistributionsData } from "../utils/distributionData";
import { distribute } from "../2_distribution";
import { generateMerkle } from "../3_merkle";
import { MerkleData } from "../interfaces/MerkleData";
import { IncentiveExtended } from "../interfaces/IncentiveExtended";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";
import { writeHolders } from "../utils/holders";

const DEFAULT_VAULT = "0x0F67C05A034fEC0183ad74d3be42c8Ba27F6c4c4" as Address;
const DEFAULT_GAUGE = "0xf69Fb60B79E463384b40dbFDFB633AB5a863C9A2" as Address;
const DEFAULT_MANAGER = "0x9A207a85E372fCDAC3014F945a65868f2a05Ba12" as Address;
const DEFAULT_REWARD_TOKEN = "0x01791F726B4103694969820be083196cC7c045fF" as Address;
const DEFAULT_START_TIMESTAMP = 1_760_691_731;
const DEFAULT_END_TIMESTAMP = 1_761_296_531;
const DEFAULT_REWARD_DECIMALS = 18;
const DEFAULT_REWARD_AMOUNT = "6651.799257828034072402";
const DEFAULT_REWARD_SYMBOL = "YB";

const DATA_DIR = path.resolve(__dirname, "../../data");
const INCENTIVES_PATH = path.resolve(DATA_DIR, "incentives.json");
const DISTRIBUTION_LOG_PATH = path.resolve(DATA_DIR, "distribution.json");
const LAST_MERKLE_PATH = path.resolve(DATA_DIR, "last_merkle.json");
const DISTRIBUTIONS_DIR = path.resolve(DATA_DIR, "distributions");
const OUTPUT_DIR = path.resolve(DATA_DIR, "tests");
const HOLDERS_PATH = path.resolve(DATA_DIR, `holders/${DEFAULT_VAULT}/index.json`);

const toScaledAmount = (value: string, decimals: number): bigint => {
    const [whole, fraction = ""] = value.split(".");
    const padded = fraction.padEnd(decimals, "0").slice(0, decimals);
    return BigInt(whole + padded);
};

const backupFile = (filePath: string): string | null => {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, { encoding: "utf-8" }) : null;
};

const restoreFile = (filePath: string, contents: string | null) => {
    if (contents === null) {
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath);
        }
        return;
    }
    fs.writeFileSync(filePath, contents, { encoding: "utf-8" });
};

const ensureDir = (dirPath: string) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

const writeOutput = (filename: string, data: unknown) => {
    ensureDir(OUTPUT_DIR);
    const target = path.resolve(OUTPUT_DIR, filename);
    fs.writeFileSync(target, JSON.stringify(data, null, 2), { encoding: "utf-8" });
    console.log(`💾 Wrote ${filename} to ${target}`);
};

const buildDefaultIncentive = (): IncentiveExtended => {
    const duration = BigInt(DEFAULT_END_TIMESTAMP - DEFAULT_START_TIMESTAMP);
    return {
        id: 0,
        gauge: DEFAULT_GAUGE,
        reward: DEFAULT_REWARD_TOKEN,
        duration,
        start: BigInt(DEFAULT_START_TIMESTAMP),
        end: BigInt(DEFAULT_END_TIMESTAMP),
        fromChainId: BigInt(1),
        sender: DEFAULT_MANAGER,
        amount: toScaledAmount(DEFAULT_REWARD_AMOUNT, DEFAULT_REWARD_DECIMALS),
        manager: DEFAULT_MANAGER,
        rewardDecimals: DEFAULT_REWARD_DECIMALS,
        rewardSymbol: DEFAULT_REWARD_SYMBOL,
        vault: DEFAULT_VAULT,
        ended: false,
    };
};

const describeMerkle = (merkle: MerkleData) => {
    console.log(`\n🌳 Merkle root: ${merkle.merkleRoot}`);
    const claims = Object.entries(merkle.claims);
    console.log(`👥 Claimants: ${claims.length}`);
    claims.slice(0, 10).forEach(([address, claim]) => {
        Object.entries(claim.tokens).forEach(([token, details]) => {
            console.log(`  ${address} -> token=${token} amount=${details.amount}`);
        });
    });
};

const main = async () => {
    ensureDir(DATA_DIR);
    ensureDir(DISTRIBUTIONS_DIR);

    const initialDistributionDirs = new Set<string>(
        fs.readdirSync(DISTRIBUTIONS_DIR, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
    );

    const backupIncentives = backupFile(INCENTIVES_PATH);
    const backupDistributionLog = backupFile(DISTRIBUTION_LOG_PATH);
    const backupLastMerkle = backupFile(LAST_MERKLE_PATH);
    const backupHolders = backupFile(HOLDERS_PATH);

    let newDistributionTimestamp: number | null = null;

    try {
        // 1. Seed incentives with the legacy defaults and reset distribution history.
        writeIncentives([buildDefaultIncentive()]);
        overideDistributionData([]);

        // 2. Run the actual pipeline: compute TWAB weights and write distribution artifacts.
        writeHolders(DEFAULT_VAULT, { blockNumber: 0, users: [] });
        await distribute();

        // Capture the generated timestamp so we can locate/remove the temp folder later.
        const distributionLog = getLastDistributionsData();
        if (distributionLog.length === 0) {
            throw new Error("Distribution run did not produce any entries.");
        }
        newDistributionTimestamp = distributionLog[distributionLog.length - 1].timestamp;

        // 3. Build the Merkle tree against the freshly generated distribution.
        await generateMerkle();

        if (!fs.existsSync(LAST_MERKLE_PATH)) {
            throw new Error("Merkle generation did not produce last_merkle.json");
        }

        const merkle = JSON.parse(fs.readFileSync(LAST_MERKLE_PATH, { encoding: "utf-8" })) as MerkleData;
        describeMerkle(merkle);
        writeOutput(
            `yb_default_${DEFAULT_START_TIMESTAMP}_${DEFAULT_END_TIMESTAMP}.json`,
            merkle,
        );

        // Also persist the combined distribution (address -> token -> amount) for diffing.
        const flat: UniversalMerkle = {};
        Object.entries(merkle.claims).forEach(([address, claim]) => {
            const checksum = getAddress(address);
            flat[checksum] = {};
            Object.entries(claim.tokens).forEach(([token, tokenData]) => {
                flat[checksum][getAddress(token)] = tokenData.amount;
            });
        });
        writeOutput(
            `yb_default_${DEFAULT_START_TIMESTAMP}_${DEFAULT_END_TIMESTAMP}_flat.json`,
            flat,
        );
    } finally {
        // Restore prior state so this test run is non-destructive.
        restoreFile(INCENTIVES_PATH, backupIncentives);
        restoreFile(DISTRIBUTION_LOG_PATH, backupDistributionLog);
        restoreFile(LAST_MERKLE_PATH, backupLastMerkle);
        restoreFile(HOLDERS_PATH, backupHolders);

        if (newDistributionTimestamp !== null) {
            const folder = path.resolve(DISTRIBUTIONS_DIR, String(newDistributionTimestamp));
            if (!initialDistributionDirs.has(String(newDistributionTimestamp)) && fs.existsSync(folder)) {
                fs.rmSync(folder, { recursive: true, force: true });
                console.log(`🧹 Removed temporary distribution folder ${folder}`);
            }
        }
    }
};

void main();
