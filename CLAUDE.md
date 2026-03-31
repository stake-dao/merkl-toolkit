# CLAUDE.md

## Au demarrage de chaque session

Lire les fichiers de documentation avant de commencer a travailler :
- `docs/architecture.md` — pipeline complet (incentives, distribution, TWAB, merkle, check, breakdown, refresh cache)
- `docs/breakdown.md` — detail du breakdown (earned/claimed/claimable par vault, timeline chronologique, scan Etherscan, types direct/morpho)

## Regles

- `refreshCache()` dans `main.ts` doit TOUJOURS etre le dernier appel de la fonction `main()`
- Ne pas committer les fichiers `data/` (donnees de distribution, merkle, breakdown)
- Les BigInt sont serialises en string via `utils/parse.ts` (`safeStringify`/`safeParse`)
- Le contrat Merkl est sur Ethereum mainnet uniquement
- Les tests de compilation ont des erreurs pre-existantes dans `node_modules/` (ox, viem) — les ignorer
