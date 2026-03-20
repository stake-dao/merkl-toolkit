import { Address } from "viem";
import { WrapperIntegration, WrapperContext } from "./types";

/**
 * Central registry of wrapper integrations.
 *
 * Usage:
 *   register(new MorphoIntegration(client));
 *   const map = await registry.buildWrapperMap();
 *   // map: wrapperAddress → { integration, context }
 */

export interface ResolvedWrapper {
    integration: WrapperIntegration;
    context: WrapperContext;
}

class IntegrationRegistry {
    private integrations: WrapperIntegration[] = [];

    register(integration: WrapperIntegration): void {
        this.integrations.push(integration);
    }

    /**
     * Query every registered integration and build a unified
     * wrapperAddress → ResolvedWrapper map.
     *
     * If two integrations claim the same address, the first one wins
     * (register order matters).
     */
    async buildWrapperMap(): Promise<Map<Address, ResolvedWrapper>> {
        const map = new Map<Address, ResolvedWrapper>();

        for (const integration of this.integrations) {
            const wrappers = await integration.getWrappers();
            for (const [address, context] of wrappers.entries()) {
                if (!map.has(address)) {
                    map.set(address, { integration, context });
                }
            }
        }

        return map;
    }
}

/** Singleton registry — import and use directly. */
export const registry = new IntegrationRegistry();
