import fs from "fs";
import path from "path";
import { Address, getAddress } from "viem";

import { writeIncentives } from "../utils/incentives";
import { overideDistributionData, getLastDistributionsData } from "../utils/distributionData";
import { distribute } from "../2_distribution";
import { IncentiveExtended } from "../interfaces/IncentiveExtended";
import { Distribution } from "../interfaces/Distribution";
import { writeHolders } from "../utils/holders";
import { safeParse } from "../utils/parse";

/**
 * Wrapper expansion test
 *
 * Uses vault 0x4fdb3c... which has wrapper 0x3B855A... as its #1 holder (~50%).
 * Runs distribute() and verifies:
 *   1. The wrapper address is replaced by its depositors
 *   2. Total distributed amount is preserved exactly
 *   3. At least one depositor appears in the output
 */

const VAULT = "0x4fdb3cb3DBD6D24B64276645c1ADCb85cbB39dC6" as Address;
const WRAPPER = "0x3B855AA8CC56a3cBd5dBb5456F5A13Ce86AA0fe8" as Address;
const GAUGE = "0x6a253c9fe5AaFF662e072Aa694CE53b917aDb278" as Address;
const MANAGER = "0xb3983cDdBa4B127960A4cDD531AB989264509e23" as Address;
const REWARD_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

const DATA_DIR = path.resolve(__dirname, "../../data");
const INCENTIVES_PATH = path.resolve(DATA_DIR, "incentives.json");
const DISTRIBUTION_LOG_PATH = path.resolve(DATA_DIR, "distribution.json");
const DISTRIBUTIONS_DIR = path.resolve(DATA_DIR, "distributions");
const HOLDERS_DIR = path.resolve(DATA_DIR, `holders/${VAULT}`);
const HOLDERS_PATH = path.resolve(HOLDERS_DIR, "index.json");

const backupFile = (filePath: string): string | null =>
    fs.existsSync(filePath) ? fs.readFileSync(filePath, { encoding: "utf-8" }) : null;

const restoreFile = (filePath: string, contents: string | null) => {
    if (contents === null) {
        if (fs.existsSync(filePath)) fs.rmSync(filePath);
        return;
    }
    fs.writeFileSync(filePath, contents, { encoding: "utf-8" });
};

const buildIncentive = (): IncentiveExtended => ({
    id: 309,
    gauge: GAUGE,
    reward: REWARD_TOKEN,
    duration: 604800n,
    start: 1773962392n,
    end: 1774567192n,
    fromChainId: 1n,
    sender: MANAGER,
    amount: 2000000000n,
    manager: MANAGER,
    vault: VAULT,
    rewardDecimals: 6,
    rewardSymbol: "USDC",
    ended: false,
    distributedUntil: 1773962392n,
    source: "direct",
});

const main = async () => {
    console.log("🧪 Wrapper expansion test");
    console.log(`   Vault:   ${VAULT}`);
    console.log(`   Wrapper: ${WRAPPER}`);
    console.log("");

    const initialDistDirs = new Set(
        fs.readdirSync(DISTRIBUTIONS_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name),
    );

    const backupIncentives = backupFile(INCENTIVES_PATH);
    const backupDistLog = backupFile(DISTRIBUTION_LOG_PATH);
    const backupHolders = backupFile(HOLDERS_PATH);

    let newTimestamp: number | null = null;

    try {
        // Setup: seed incentive and reset distribution log
        writeIncentives([buildIncentive()]);
        overideDistributionData([]);

        // Reset holders cache to force fresh scan
        writeHolders(VAULT, { blockNumber: 0, users: [] });

        // Run distribution
        console.log("⏳ Running distribute()...\n");
        await distribute();

        // Read the output
        const distLog = getLastDistributionsData();
        if (distLog.length === 0) throw new Error("No distribution produced");
        newTimestamp = distLog[distLog.length - 1].timestamp;

        const distPath = path.resolve(DISTRIBUTIONS_DIR, String(newTimestamp), "distribution.json");
        const distribution = safeParse(
            fs.readFileSync(distPath, { encoding: "utf-8" }),
        ) as Distribution;

        // Find our vault's incentive distribution
        const vaultDists = distribution.incentives.filter(
            (d) => getAddress(d.vault) === getAddress(VAULT),
        );

        if (vaultDists.length === 0) {
            throw new Error(`No distribution found for vault ${VAULT}`);
        }

        console.log(`\n📊 Found ${vaultDists.length} distribution(s) for vault`);

        let allPassed = true;

        for (const dist of vaultDists) {
            console.log(`\n--- Incentive ${dist.distribution.incentiveId} (${dist.token.symbol}) ---`);

            // Check 1: wrapper should NOT appear in users
            const wrapperUser = dist.users.find(
                (u) => getAddress(u.user) === getAddress(WRAPPER),
            );
            if (wrapperUser) {
                console.log(`❌ FAIL: Wrapper ${WRAPPER} still in users with amount=${wrapperUser.amount}`);
                allPassed = false;
            } else {
                console.log(`✅ PASS: Wrapper ${WRAPPER} not in final users`);
            }

            // Check 2: total amount must match amountToDistribute
            const totalDistributed = dist.users.reduce(
                (sum, u) => sum + BigInt(u.amount),
                0n,
            );
            const expected = BigInt(dist.distribution.amountToDistribute);

            if (totalDistributed === expected) {
                console.log(`✅ PASS: Total amount preserved (${totalDistributed})`);
            } else {
                console.log(`❌ FAIL: Total mismatch — distributed=${totalDistributed} expected=${expected}`);
                allPassed = false;
            }

            // Check 3: should have more users than before (wrapper replaced by depositors)
            console.log(`   Users: ${dist.users.length}`);
            if (dist.users.length < 2) {
                console.log(`❌ FAIL: Expected multiple users after expansion`);
                allPassed = false;
            } else {
                console.log(`✅ PASS: Multiple users in output`);
            }

            // Print top holders
            const sorted = [...dist.users].sort(
                (a, b) => Number(BigInt(b.amount) - BigInt(a.amount)),
            );
            console.log("\n   Top 10 holders:");
            for (const u of sorted.slice(0, 10)) {
                console.log(`     ${u.user}  amount=${u.amount}  share=${u.share}`);
            }
        }

        console.log(allPassed ? "\n🎉 All checks passed!" : "\n💥 Some checks failed!");
        process.exit(allPassed ? 0 : 1);
    } finally {
        restoreFile(INCENTIVES_PATH, backupIncentives);
        restoreFile(DISTRIBUTION_LOG_PATH, backupDistLog);
        restoreFile(HOLDERS_PATH, backupHolders);

        if (newTimestamp !== null) {
            const folder = path.resolve(DISTRIBUTIONS_DIR, String(newTimestamp));
            if (!initialDistDirs.has(String(newTimestamp)) && fs.existsSync(folder)) {
                fs.rmSync(folder, { recursive: true, force: true });
                console.log(`🧹 Removed temp distribution folder`);
            }
        }
    }
};

void main();
