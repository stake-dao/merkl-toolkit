import { getMerklLastId, getNewIncentives, getIncentiveSource } from './utils/merkl';
import { getIncentives, writeIncentives } from './utils/incentives';
import { CURVE_RECOVERIES, RECOVERY_MIN_INCENTIVE_ID } from './recovery/curve';

export const fetchIncentives = async () => {
    let incentives = await getIncentives();

    // Backfill source field for existing incentives missing it
    let backfilled = 0;
    for (const incentive of incentives) {
        if (incentive.source === undefined) {
            incentive.source = getIncentiveSource(incentive.sender);
            backfilled++;
        }
    }
    if (backfilled > 0) {
        console.log(`🔧 Backfilled 'source' field for ${backfilled} incentive(s)`);
        writeIncentives(incentives);
    }

    // Fetch new ones
    const incentiveIds = incentives.map(i => i.id)
    const lastId = incentiveIds.length > 0 ? Math.max(...incentiveIds) + 1 : 0;
    console.log(`🗂️  Last local incentive ID: ${lastId}`);

    const lastIncentiveId = await getMerklLastId();
    console.log(`🌐 Last on-chain incentive ID: ${lastIncentiveId}`);

    // Retry only configured recoveries skipped by earlier runs, even after the cursor advanced.
    const retryIds = [...new Set(CURVE_RECOVERIES.map(entry => entry.incentiveId).filter(id =>
        Number.isSafeInteger(id) && id >= RECOVERY_MIN_INCENTIVE_ID &&
        id < Math.min(lastId, lastIncentiveId) && !incentiveIds.includes(id)))];

    if (lastId < lastIncentiveId || retryIds.length > 0) {
        // Fetch new incentives
        if (lastId < lastIncentiveId) console.log(`🔄 Fetching new incentives from ID ${lastId} to ${lastIncentiveId - 1}...`);
        if (retryIds.length > 0) console.log(`🔄 Retrying Curve recovery IDs: ${retryIds.join(', ')}`);
        const newIncentives = await getNewIncentives(lastId, lastIncentiveId, retryIds)
        incentives = incentives.concat(newIncentives);
        console.log(`✅ Fetched ${newIncentives.length} new incentive(s)`);

        // Store
        writeIncentives(incentives);
    } else {
        console.log(`✅ No new incentive`);
    }
}