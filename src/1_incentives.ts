import { getMerklLastId, getNewIncentives } from './utils/merkl';
import { getIncentives, writeIncentives } from './utils/incentives';

export const fetchIncentives = async () => {
    let incentives = await getIncentives();

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