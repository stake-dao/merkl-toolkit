import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const WORKER_URL = process.env.WORKER_URL?.replace(/\/+$/, "");
const MAX_RETRIES = 3;
const BASE_DELAY = 2000;

const postWithRetry = async (url: string, body?: object): Promise<any> => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { data, status } = await axios.post(url, body);
            console.log(`   ${status} OK`);
            return data;
        } catch (err: any) {
            const status = err.response?.status ?? "network error";
            console.error(`   Attempt ${attempt}/${MAX_RETRIES} failed (${status})`);
            if (attempt === MAX_RETRIES) throw err;
            const delay = BASE_DELAY * Math.pow(2, attempt - 1);
            console.log(`   Retrying in ${delay / 1000}s...`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
};

export const refreshCache = async () => {
    if (!WORKER_URL) {
        throw new Error("WORKER_URL is not set in environment");
    }

    console.log("🔄 Refreshing caches via Cloudflare worker...\n");

    console.log(`📤 POST ${WORKER_URL}/clear`);
    await postWithRetry(`${WORKER_URL}/clear`, { key: "incentives" });

    console.log(`📤 POST ${WORKER_URL}/update/curve`);
    await postWithRetry(`${WORKER_URL}/update/curve`);

    console.log("\n✅ Cache refresh complete");
};

if (require.main === module) {
    refreshCache().catch((err) => {
        console.error("❌ Cache refresh failed:", err.message ?? err);
        process.exit(1);
    });
}
