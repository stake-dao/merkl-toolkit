import entries from "../../config/curve-recovery.json";
import type { IncentiveExtended } from "../interfaces/IncentiveExtended";

export type CurveRecovery = Omit<typeof entries[number], "incentiveId"> & { incentiveId: number | null };
export const CURVE_RECOVERIES: CurveRecovery[] = entries;
export const RECOVERY_HOOK = "0x68654D460fDF3231B49B25817cBBD72d8d291Fcf";
const SOURCE_CHAIN_ID = 42161n;

type Candidate = Pick<IncentiveExtended, "id" | "gauge" | "reward" | "amount" | "manager" | "sender" | "fromChainId">;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function recoveryForIncentive(incentive: Candidate, recoveries = CURVE_RECOVERIES): CurveRecovery | undefined {
    if (incentive.fromChainId !== SOURCE_CHAIN_ID || !same(incentive.sender, RECOVERY_HOOK)) return undefined;
    return recoveries.find((entry) =>
        entry.incentiveId === incentive.id &&
        same(entry.gauge, incentive.gauge) && same(entry.reward, incentive.reward) &&
        BigInt(entry.amount) === incentive.amount && same(entry.manager, incentive.manager));
}
