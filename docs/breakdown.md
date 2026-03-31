# Breakdown - Documentation technique

## Objectif

Le breakdown genere un fichier `data/breakdown/breakdown.json` qui detaille, pour chaque user, vault et token de reward :
- **earned** : montant total gagne via ce vault
- **claimed** : montant deja reclame, attribue a ce vault
- **claimable** : montant restant a reclamer, attribue a ce vault
- **type** : `"direct"` (holder du vault), `"morpho"` (deposant via Morpho lending), ou `"both"`

Ce fichier est le complement du merkle (`last_merkle.json`) qui lui n'a que la vue `user -> token -> totalAmount` sans la dimension vault.

## Probleme resolu

Le contrat Merkl stocke les rewards et claims par `(user, token)`, sans dimension vault. Si un user gagne 50 USDC via vault A et 50 USDC via vault B, le merkle contient `user -> USDC -> 100`. Le breakdown preserve la provenance : `vaultA: 50, vaultB: 50`.

Pour les claims, le contrat `claimed(user, token)` retourne un total. Le breakdown repartit ce total entre les vaults de maniere exacte en reconstituant la timeline historique des distributions et des claims.

## Fichiers produits

```
data/breakdown/
  meta.json        # etat incremental (lastProcessedTimestamp, lastScannedBlock)
  earned.json      # earned entries par user-token (donnees brutes pour recomputation)
  claims.json      # claim events par user-token (scan Etherscan, cache incremental)
  breakdown.json   # resultat final (le seul fichier utile pour l'UI)
```

## Structure du breakdown.json

```json
{
  "0xUserAddress": {
    "0xVaultAddress": {
      "0xRewardTokenAddress": {
        "earned": "150000000",
        "claimed": "80000000",
        "claimable": "70000000",
        "type": "direct"
      }
    },
    "0xOtherVault": {
      "0xRewardTokenAddress": {
        "earned": "50000000",
        "claimed": "20000000",
        "claimable": "30000000",
        "type": "morpho"
      }
    }
  }
}
```

Invariants :
- `sum(claimable)` par user/token = `merkleAmount - claimedOnChain` (exact, reconcilie avec le merkle)
- `sum(claimed)` par user/token <= `claimedOnChain` (le claimed on-chain est la source de verite)
- `earned` est le montant brut des distribution files (peut differer du merkle a cause des dettes/patches)

## Pipeline en 4 phases

### Phase 1 : Accumulation des earned entries

**Source** : fichiers `data/distributions/{timestamp}/distribution.json`

Pour chaque distribution envoyee on-chain (`sentOnchain: true`), lit les incentives et extrait les montants par `(user, vault, token)`. Chaque earned entry a un timestamp (celui de la distribution) et une source (`"direct"` ou `"morpho"`).

**Incrementalite** : `meta.lastProcessedTimestamp` indique la derniere distribution traitee. Seules les nouvelles sont lues. Le resultat est persiste dans `earned.json`.

**Determination de la source** :
- Si le fichier distribution a le champ `source` sur le user (nouvelles distributions) : utilise directement
- Sinon (anciennes distributions) : heuristique `balance == 0` + presence dans les caches Morpho (`data/holders/morpho/*/index.json`) → `"morpho"`, sinon `"direct"`

Le champ `source: "morpho"` est ecrit par `integrations/expand.ts` lors du wrapper expansion : seuls les deposants qui n'ont PAS de position directe dans le vault sont tagges morpho.

### Phase 2 : Scan des claim events via Etherscan

**Source** : Etherscan API v2, endpoint `getLogs`

Scanne tous les events `Transfer(from, to, value)` emis par n'importe quel token ERC20, ou `from = MERKL_CONTRACT`. Chaque Transfer sortant du contrat Merkl est un claim. Le token est deduit du champ `address` du log (le contrat qui a emis l'event).

**Query Etherscan** (un seul scan pour tous les tokens) :
```
topic0 = 0xddf252ad...  (Transfer event signature)
topic1 = 0x000...d4898a... (from = MERKL_CONTRACT, padded 32 bytes)
topic0_1_opr = and
```

Pas de filtre `address`, ce qui retourne les Transfers de TOUS les tokens depuis le contrat Merkl en un seul pass.

**Incrementalite** : `meta.lastScannedBlock` indique le dernier block scanne. Seuls les nouveaux blocks sont scannes. Les events sont persistes dans `claims.json`.

**Parametres** :
- Step : 10,000 blocks par requete
- Page size : 1,000 events par page
- Retry : backoff exponentiel, 50 tentatives max
- Split automatique si "Result window is too large"

### Phase 3 : Fetch des claimed amounts on-chain

**Source** : multicall `claimed(user, token)` sur le contrat Merkl

Pour chaque paire `(user, token)` dans les earned entries, lit le montant deja reclame on-chain. Ces valeurs sont la source de verite pour le total claimed.

Le merkle (`last_merkle.json`) est aussi charge pour obtenir les `merkleAmount` par user/token — source de verite pour le total claimable.

### Phase 4 : Traitement chronologique des timelines

Pour chaque `(user, token)`, on fusionne les earned entries et les claim events en une timeline chronologique, puis on la parcourt pour calculer le claimed exact par vault.

#### Algorithme

```
Timeline = merge(earned entries, claim events) triee par timestamp
  (a timestamp egal, les earn passent avant les claim)

vaultEarned = {}     # vault -> montant cumule
vaultClaimed = {}    # vault -> montant claimed cumule

Pour chaque event dans la timeline :
  Si EARN :
    vaultEarned[vault] += amount

  Si CLAIM :
    Pour chaque vault :
      pending[vault] = vaultEarned[vault] - vaultClaimed[vault]
    totalPending = sum(pending)

    # Repartir le claim proportionnellement au pending de chaque vault
    Pour chaque vault (dernier recoit le reste pour arrondi) :
      share = claimAmount * pending[vault] / totalPending
      vaultClaimed[vault] += share
```

#### Pourquoi c'est exact

A chaque instant ou un claim se produit, la composition du pending par vault est connue avec precision :
- Les earned entries viennent des distribution files avec leurs timestamps
- Les claim events viennent d'Etherscan avec le timestamp du block

Quand un user claim, le contrat Merkl envoie `merkleAmount - alreadyClaimed` tokens. Ce montant est distribue proportionnellement au pending de chaque vault **a cet instant precis**. Puisque la composition du pending ne change qu'aux bornes des distributions, le resultat est exact.

**Exemple concret** :

```
Distribution 1 (ts=100): vault A donne 100 USDC
  → pending = {A: 100}

Claim (ts=150): user claim 80 USDC
  → 100% de A → vaultClaimed = {A: 80}

Distribution 2 (ts=200): vault A donne 50, vault B donne 50 USDC
  → pending = {A: 100-80+50=70, B: 50}

Claim (ts=250): user claim 120 USDC
  → A: 120 * 70/120 = 70, B: 120 * 50/120 = 50
  → vaultClaimed = {A: 150, B: 50}

Resultat final :
  vault A: earned=150, claimed=150, claimable=0
  vault B: earned=50, claimed=50, claimable=0
```

#### Reconciliation avec le merkle

Le claimable final est reconcilie avec le merkle (source de verite) :

```
pendingOnChain = merkleAmount - claimedOnChain

Pour chaque vault, claimable est distribue proportionnellement au "remaining" :
  remaining[vault] = vaultEarned[vault] - vaultClaimed[vault]
  claimable[vault] = pendingOnChain * remaining[vault] / totalRemaining
```

Le dernier vault recoit le reste (`pendingOnChain - allocated`) pour garantir que `sum(claimable) = pendingOnChain` exactement.

Si `totalRemaining = 0` (tout a ete claimed) mais `pendingOnChain > 0` (cas de patch/dette), le fallback distribue proportionnellement aux earned ratios.

## Modes d'execution

| Commande | Comportement |
|----------|-------------|
| `pnpm breakdown --rebuild` | Reset complet : relit toutes les distributions, rescanne tous les blocks, recompute tout |
| `pnpm breakdown` | Incremental : seules les nouvelles distributions et les nouveaux blocks sont traites. Les timelines sont toujours recomputees |
| Depuis `main.ts` | Appele apres check(), mode incremental (1 distribution + quelques blocks) |

Le `--rebuild` est necessaire apres un `git pull` qui modifie les fichiers de data.

## Type de produit

Chaque entree du breakdown a un champ `type` :
- `"direct"` : l'user detient des tokens du vault directement
- `"morpho"` : l'user a depose dans un marche Morpho qui utilise le vault comme collateral
- `"both"` : l'user a des positions des deux types sur le meme vault/token

La source est determinee :
1. **Nouvelles distributions** : le champ `source` est ecrit par `integrations/expand.ts` lors du wrapper expansion
2. **Anciennes distributions** (sans champ `source`) : heuristique basee sur `balance == 0` + presence dans les caches `data/holders/morpho/*/index.json`

## Validation

Le script `src/tests/7_test_breakdown.ts` valide le breakdown :
1. Pour chaque `(user, token)` avec claimable > 0, somme les claimable de tous les vaults
2. Simule un `claim()` via `eth_call` (avec `stateDiff` pour override la root si necessaire)
3. Compare le montant retourne par `claim()` avec la somme des claimable
4. `actual == expected` = le breakdown est correct

```
pnpm breakdown --rebuild
pnpm test-breakdown
```

Les deux doivent etre executes sur les memes donnees (pas de `git pull` entre les deux).
