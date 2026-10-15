import entries from "../../config/curve-recovery.json";
import type { IncentiveExtended } from "../interfaces/IncentiveExtended";

export type CurveRecovery = Omit<typeof entries[number], "incentiveId"> & { incentiveId: number | null };
export const CURVE_RECOVERIES: CurveRecovery[] = entries;
export const RECOVERY_HOOK = "0x68654D460fDF3231B49B25817cBBD72d8d291Fcf";
// nbIncentives before recovery, confirmed at mainnet block 26197114. Keep fixed.
export const RECOVERY_MIN_INCENTIVE_ID = 2467;
const SOURCE_CHAIN_ID = 42161n;

type Candidate = Pick<IncentiveExtended, "id" | "gauge" | "reward" | "amount" | "manager" | "sender" | "fromChainId">;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function recoveryForIncentive(incentive: Candidate, recoveries = CURVE_RECOVERIES): CurveRecovery | null | undefined {
    const configured = recoveries.filter((entry) => entry.incentiveId === incentive.id);
    const expectedOrigin = incentive.fromChainId === SOURCE_CHAIN_ID && same(incentive.sender, RECOVERY_HOOK);
    const candidates = incentive.id < RECOVERY_MIN_INCENTIVE_ID || !expectedOrigin ? [] : recoveries.filter((entry) =>
        same(entry.reward, incentive.reward) && BigInt(entry.amount) === incentive.amount);
    if (configured.length === 0 && candidates.length === 0) return undefined;
    if (configured.length !== 1 || candidates.length !== 1 || configured[0] !== candidates[0] ||
        !same(configured[0].gauge, incentive.gauge) || !same(configured[0].manager, incentive.manager)) {
        console.warn(`Skipping incentive #${incentive.id}: configure its exact Curve recovery ID and matching fields before import`);
        return null;
    }
    const recovery = configured[0];
    if (recovery.historicalStart % 604800 !== 0 || recovery.historicalEnd - recovery.historicalStart !== 604800) {
        console.warn(`Skipping incentive #${incentive.id}: invalid historical campaign week for ${recovery.id}`);
        return null;
    }
    return recovery;
}
