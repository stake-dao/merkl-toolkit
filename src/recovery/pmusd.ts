import path from "node:path";
import { getAddress } from "viem";
import allocations from "../../config/pmusd-twab-recovery.json";
import type { Distribution, IncentiveDistribution } from "../interfaces/Distribution";
import type { DistributionData } from "../interfaces/DistributionData";
import { openEmptyRound, read, write } from "./round";

const token = { address: getAddress("0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf"), symbol: "pmUSD", decimals: 18 };

/** Reimburse holders from the March 2026 TWAB windows with the pmUSD returned by Stake DAO (ENG-2316). */
export async function applyPmusdRecovery(dir: string, getBlock: () => Promise<{ number: bigint; timestamp: bigint }>) {
    const indexFile = path.join(dir, "distribution.json");
    const index = read<DistributionData[]>(indexFile);
    if (index.some(round => round.pmusdRecovery && round.sentOnchain)) return;

    const last = index[index.length - 1];
    if (!last || index.slice(0, -1).some(round => !round.sentOnchain)) {
        throw new Error("Expected a distribution history with at most one pending final round");
    }
    const round = last.sentOnchain ? openEmptyRound(dir, index, await getBlock()) : last;
    const file = path.join(dir, "distributions", String(round.timestamp), "distribution.json");
    const distribution = read<Distribution>(file);
    if (distribution.timestamp !== round.timestamp || distribution.blockNumber !== round.blockNumber) {
        throw new Error("Pending pmUSD distribution differs from its index");
    }

    const credits = allocations.map(({ vault, incentiveId, allocations: amounts }): IncentiveDistribution => {
        const users = Object.entries(amounts).map(([user, amount]) => ({
            user: getAddress(user), amount, balance: "0", share: "0.000000", source: "direct" as const,
        }));
        const amountToDistribute = users.reduce((sum, user) => sum + BigInt(user.amount), 0n);
        return {
            vault: getAddress(vault), token, users,
            distribution: { incentiveId, amountToDistribute, incentivePerSecond: 0n, recovery: "pmusd-twab" },
        };
    });
    if (credits.reduce((sum, row) => sum + row.distribution.amountToDistribute, 0n) !== 353239532329539949908n) {
        throw new Error("pmUSD recovery allocations do not match the reimbursed amount");
    }

    // A retry between the two atomic writes must replace the same credits.
    distribution.incentives = distribution.incentives.filter(row => row.distribution.recovery !== "pmusd-twab").concat(credits);
    write(file, distribution);
    round.pmusdRecovery = true;
    write(indexFile, index);
}
