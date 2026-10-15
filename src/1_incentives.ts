import { getMerklLastId, getNewIncentives, getIncentiveSource } from './utils/merkl';
import { getIncentives, writeIncentives } from './utils/incentives';

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

    if (lastId < lastIncentiveId) {
        // Fetch new incentives
        console.log(`🔄 Fetching new incentives from ID ${lastId} to ${lastIncentiveId - 1}...`);
        const newIncentives = await getNewIncentives(lastId, lastIncentiveId)
        incentives = incentives.concat(newIncentives);
        console.log(`✅ Fetched ${newIncentives.length} new incentive(s)`);

        // Store
        writeIncentives(incentives);
    } else {
        console.log(`✅ No new incentive`);
    }
}