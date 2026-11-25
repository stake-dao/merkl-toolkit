import { getMerklLastId, getNewIncentives, getIncentiveSource } from './utils/merkl';
import { getIncentives } from './utils/incentives';

export const fetchIncentives = async () => {
    const incentives = await getIncentives();

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
        console.log(`✅ Fetched ${newIncentives.length} new incentive(s)`);
        return incentives.concat(newIncentives);
    }
    console.log(`✅ No new incentive`);
    return backfilled > 0 ? incentives : undefined;
}
