# Merkl Toolkit - Documentation technique

## Vue d'ensemble

Pipeline de distribution de rewards off-chain pour Stake DAO, base sur le protocole Merkl. Tourne sur Ethereum mainnet. Gere le cycle complet : lecture des incentives on-chain, calcul des allocations par TWAB, generation du Merkle tree, verification de solvabilite et simulation des claims.

Le pipeline s'execute en 7 etapes sequentielles depuis `src/main.ts` :

| Etape | Fichier | Role |
|-------|---------|------|
| 0 (optionnel) | `5_patch.ts` | Corrige le merkle si des users ont overclaim |
| 1 | `1_incentives.ts` | Fetch les nouveaux incentives depuis le contrat Merkl |
| 2 | `2_distribution.ts` | Calcule les allocations par holder via TWAB |
| 3 | `3_merkle.ts` | Genere le Merkle tree cumulatif |
| 4 | `4_check.ts` | Verifie solvabilite + simule chaque claim |
| 5 | `6_breakdown.ts` | Genere le breakdown par user/vault/token |
| 6 | `7_refresh_cache.ts` | Rafraichit les caches via le worker Cloudflare |

**IMPORTANT** : `refreshCache()` doit TOUJOURS etre le dernier appel dans `main()`. C'est l'etape qui invalide les caches du frontend — elle ne doit s'executer qu'une fois que toutes les donnees (merkle, breakdown) sont finalisees et ecrites sur disque.

### Adresses cles

| Nom | Adresse | Fichier |
|-----|---------|---------|
| Contrat Merkl | `0xd4898a378ea555595c4e7dbde722b134a3f346d1` | `constants.ts` |
| Treasury | `0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063` | `constants.ts` |
| Morpho | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | `integrations/morpho/index.ts` |
| VoteMarket Hook v1 | `0x06Ab7052b00d038F8EeF33B267C23b5154cE8cDc` | `utils/merkl.ts` |
| VoteMarket Hook v2 | `0x68654D460fDF3231B49B25817cBBD72d8d291Fcf` | `utils/merkl.ts` |
| AllMight | `0xDBd24b092f686b12650EC1450e3A7138F714506c` | `utils/merkl.ts` |

### ABI du contrat Merkl (`abis/Merkl.ts`)

```
nbIncentives() -> uint256                     // nombre total d'incentives
incentives(uint256 i) -> (gauge, reward,      // lecture d'un incentive par ID
  duration, start, end, fromChainId,
  sender, amount, manager)
claimed(address user, address token) -> uint256  // montant deja claim
root() -> bytes32                             // merkle root courante
claim(address, address, uint256, bytes32[])   // claim avec preuve
  -> uint256
```

### Sources de donnees externes

| Source | Usage | Fichier |
|--------|-------|---------|
| API Stake DAO (`raw.githubusercontent.com/stake-dao/api`) | Strategies Curve v2, Balancer v2, Pendle | `utils/merkl.ts` |
| Etherscan API v2 | Decouverte des holders via scan des Transfer events | `utils/tokenHolderScanner.ts` |
| API Lending Stake DAO (`api-lending.stakedao.org`) | Marches Morpho (collateralToken, marketId) | `integrations/morpho/index.ts` |
| RPCs Ethereum | Lectures on-chain (Alchemy, Tenderly, public nodes) | `utils/rpc.ts` |

### Structure des donnees persistees

```
data/
  incentives.json                          # cache local de tous les incentives
  distribution.json                        # index des distributions [{timestamp, blockNumber, sentOnchain}]
  last_merkle.json                         # dernier merkle genere
  debts.json                               # dettes des users qui ont overclaim
  initial_debts.json                       # snapshot initial des dettes (reference)
  holders/
    {vault}/index.json                     # cache des holders par vault {blockNumber, users[]}
    morpho/{wrapper}/index.json            # cache des deposants Morpho par wrapper
  distributions/
    {timestamp}/
      distribution.json                    # distribution canonique
      merkle.json                          # merkle tree pour ce timestamp
      gauges/{vault}.json                  # snapshot debug/audit par vault
```

---

## Etape 1 - Fetch des incentives

**Fichiers** : `1_incentives.ts`, `utils/merkl.ts`, `utils/incentives.ts`

### Flux

1. Charge `data/incentives.json` (cache local). Si le fichier n'existe pas, demarre a vide.
2. Backfill du champ `source` pour les incentives existants qui ne l'ont pas encore (migration).
3. Determine le dernier ID local (`max(ids) + 1`).
4. Appelle `nbIncentives()` sur le contrat Merkl pour obtenir le dernier ID on-chain.
5. Pour chaque nouvel ID dans `[lastLocalId, lastOnChainId)`, appelle `incentives(i)`.

### Filtrage des incentives

Chaque incentive brut est filtre :
- **Ignore** si `reward == 0x0` ET `amount == 0` (incentive vide/invalide).
- **Ignore** si le `gauge` ne correspond a aucune strategie Stake DAO deployee.

Le lookup des strategies se fait via l'API Stake DAO :
- Pour Pendle : match sur `strategy.lpToken.address == incentive.gauge`
- Pour Curve v2 / Balancer v2 : match sur `strategy.gaugeAddress == incentive.gauge`

Si match, le `vault` (adresse du share token) est extrait de la strategie.

### Classification de la source

Fonction `getIncentiveSource(sender)` dans `utils/merkl.ts` :

| Source | Condition |
|--------|-----------|
| `"vm"` | Le sender est une adresse VoteMarket IncentiveGaugeHook connue |
| `"gauge"` | Le sender est une adresse AllMight connue |
| `"direct"` | Tout autre sender |

### Structure d'un incentive etendu (`IncentiveExtended`)

```typescript
{
  id: number;                    // ID sequentiel on-chain
  gauge: string;                 // adresse du gauge (Curve/Balancer/Pendle)
  reward: string;                // adresse du token de reward
  duration: bigint;              // duree totale en secondes
  start: bigint;                 // timestamp de debut
  end: bigint;                   // timestamp de fin
  fromChainId: bigint;           // chain d'origine
  sender: string;                // createur de l'incentive
  amount: bigint;                // montant total
  manager: string;               // gestionnaire
  vault: string;                 // share token (derive de la strategie)
  rewardDecimals: number;        // decimales du token reward
  rewardSymbol: string;          // symbole du token reward
  ended: boolean;                // true si entierement distribue
  distributedUntil: bigint;      // timestamp jusqu'ou les rewards ont ete distribuees
  source: "vm" | "direct" | "gauge";
}
```

---

## Etape 2 - Distribution (calcul TWAB)

**Fichiers** : `2_distribution.ts`, `utils/twab.ts`, `utils/chain.ts`, `utils/token.ts`, `utils/tokenHolderScanner.ts`, `integrations/expand.ts`

### 2.1 Decoupage temporel (`toWindowsByVault`)

Pour chaque incentive actif (`ended == false`), on calcule la fenetre de distribution :

```
windowStart = max(incentive.start, incentive.distributedUntil)
windowEnd   = min(currentTimestamp, incentive.end)
fullDuration = incentive.end - incentive.start
```

Conditions de skip :
- `fullDuration <= 0` : incentive invalide
- `windowStart >= windowEnd` : rien a distribuer dans cette fenetre

Calcul du montant :
```
incentivePerSecond = amount / fullDuration          // taux lineaire
elapsed = windowEnd - windowStart
amountToDistribute = incentivePerSecond * elapsed
```

Les incentives sont **groupes par vault**. Un meme vault peut avoir plusieurs windows (plusieurs incentives actifs avec des reward tokens ou periodes differents).

### 2.2 Construction des snapshots (`buildSnapshots`)

Pour chaque vault, on replay l'historique des transferts du share token une seule fois, meme si plusieurs incentives visent ce vault.

**Etapes** :

1. **Binary search des blocks** (`blockAtOrAfter`, `blockAtOrBefore` dans `utils/chain.ts`) :
   - Trouve le block Ethereum correspondant a `windowStart` et `windowEnd`
   - Binary search sur les timestamps de blocks avec cache (`BlockTimestampCache`)

2. **Decouverte des holders** (`utils/token.ts` -> `utils/tokenHolderScanner.ts`) :
   - Charge le cache `data/holders/{vault}/index.json`
   - Scanne les nouveaux events Transfer via Etherscan API v2 depuis le dernier block connu
   - Pagination par pages de 1000, chunks de 10,000 blocks
   - Split automatique si "Result window is too large"
   - Retry avec backoff exponentiel (rate limit)
   - Met a jour le cache

3. **Balances initiales** (`TokenHolderScanner.getBalancesAtBlock`) :
   - Multicall `balanceOf` au block `startBlock - 1` pour tous les holders
   - Batchs de 100 avec fallback individuel en cas d'erreur
   - **Validation** : `sum(balances) >= totalSupply`. Si non, `process.exit(1)`.

4. **Fetch des Transfer logs** (`fetchTransferLogs` dans `utils/chain.ts`) :
   - `getLogs` sur le share token, event `Transfer(address indexed from, address indexed to, uint256 value)`
   - Par chunks de 20,000 blocks (`DEFAULT_LOG_CHUNK_SIZE`)
   - Tri par `(blockNumber, logIndex)`

5. **Replay TWAB** (`computeTwabSnapshots` dans `utils/twab.ts`) : voir section 2.3.

### 2.3 Algorithme TWAB en detail (`utils/twab.ts`)

Le TWAB (Time-Weighted Average Balance) mesure la contribution de chaque holder en ponderant sa balance par le temps de detention.

#### Structures internes

```typescript
interface HolderState {
    balance: bigint;                      // balance courante
    lastSettledSecondsPerShare: bigint;    // derniere valeur de l'accumulateur au settlement
    weightedSecondsHeld: bigint;          // poids cumule
}
```

Variables globales :
- `secondsPerVaultShare` : accumulateur global, scale `1e36` (`SECONDS_PER_SHARE_SCALE`)
- `totalSupply` : supply courante du share token
- `currentTimestamp` : horloge de la simulation

#### Fonctions cles

**`advanceTo(target)`** : avance l'horloge et met a jour l'accumulateur global
```
if target > currentTimestamp AND totalSupply > 0:
    secondsPerVaultShare += (target - currentTimestamp) * 1e36 / totalSupply
currentTimestamp = target
```

**`settleHolder(address)`** : materialise le poids accumule depuis le dernier settlement
```
delta = secondsPerVaultShare - state.lastSettledSecondsPerShare
if delta > 0 AND state.balance > 0:
    state.weightedSecondsHeld += state.balance * delta
state.lastSettledSecondsPerShare = secondsPerVaultShare
```

**`settleAllHolders()`** : appelle `settleHolder` pour tous les holders. Utilise avant de prendre un snapshot.

#### Boucle de replay

```
Pour chaque Transfer log (chronologique) :
    1. Resolve le timestamp du block (avec cache)
    2. Si des checkpoints se trouvent avant ce transfer :
       - advanceTo(checkpoint)
       - settleAllHolders()
       - snapshot = copie de weightedSecondsHeld de chaque holder
    3. advanceTo(eventTimestamp)
    4. Si from != 0x0 :
       - settleHolder(from)
       - from.balance -= value
    5. Si to != 0x0 :
       - settleHolder(to)
       - to.balance += value
    6. Si from == 0x0 (mint) : totalSupply += value
    7. Si to == 0x0 (burn) : totalSupply -= value

Apres tous les logs :
    - Flush les checkpoints restants
    - S'assurer que start et end sont dans les snapshots
```

#### Resultat

`SnapshotMap = Map<timestamp, Map<address, weightedSecondsHeld>>`

Chaque snapshot est une photo de l'accumulateur `weightedSecondsHeld` a un timestamp donne.

### 2.4 Calcul des allocations par window (`toDistributionForWindow`)

Pour chaque window d'incentive :

```
weight[user] = snapshot[endTimestamp][user] - snapshot[startTimestamp][user]
```

Le delta donne le poids TWAB de chaque user pour cette fenetre specifique. Seuls les deltas > 0 sont conserves.

```
totalWeight = sum(weight[user] pour tout user)
amount[user] = amountToDistribute * weight[user] / totalWeight
```

**Gestion des arrondis** : le dernier user (par poids decroissant) recoit `amountToDistribute - sum(allocated)` pour garantir que la somme est exacte.

**Cas sans holders** : si `totalWeight == 0` (aucun holder durant la window), tout le montant va au `manager` de l'incentive.

### 2.5 Expansion des wrappers (`integrations/expand.ts`)

Certains holders du vault sont des **contrats wrappers** qui detiennent des shares pour le compte de deposants (ex: Morpho lending markets).

#### Flux

1. Le `IntegrationRegistry` (`integrations/registry.ts`) construit une map `wrapperAddress -> { integration, context }`
2. Pour chaque user de la distribution qui est un wrapper connu :
   a. Recupere le montant alloue au wrapper
   b. Via l'integration, decouvre les deposants du wrapper
   c. Recupere leurs balances initiales au block snapshot
   d. Recupere les "Transfer" logs specifiques a l'integration
   e. Execute un **sub-TWAB** (meme `computeTwabSnapshots`) avec les events du wrapper
   f. Calcule les poids par deposant et repartit le montant du wrapper proportionnellement
3. Si un deposant detient aussi directement des vault shares, ses montants sont additionnes
4. Si un deposant n'a de position que via le wrapper, il est ajoute a la liste des users

#### Integration Morpho (`integrations/morpho/index.ts`)

**Decouverte des wrappers** : query GraphQL sur l'API lending → `{ Market { collateralToken, marketId } }`. Chaque `collateralToken` est un wrapper.

**Mapping des events vers des TransferLogs synthetiques** :
| Event wrapper | TransferLog synthetique |
|--------------|------------------------|
| `Deposited(caller, receiver, amount, marketId)` | `{ from: 0x0, to: receiver, value: amount }` (mint) |
| `Withdrawn(user, amount)` | `{ from: user, to: 0x0, value: amount }` (burn) |
| `Liquidated(liquidator, victim, amount)` | `{ from: victim, to: 0x0, value: amount }` (burn) |

**Balances** : lecture via `position(marketId, user)` sur le contrat Morpho, champ `collateral` (index 2).

**TotalSupply** : `balanceOf(MORPHO_ADDRESS)` sur le wrapper (= combien de wrapper tokens sont deposes comme collateral dans Morpho).

**Cache des deposants** : `data/holders/morpho/{wrapper}/index.json`, incremental (meme pattern que les vault holders).

**Note sur les liquidations** : un user liquide continue a earn des rewards jusqu'a l'appel de `claimLiquidation`, coherent avec la comptabilite interne du wrapper.

### 2.6 Persistence de la distribution

A la fin de l'etape 2 :
- Ecrit `data/distributions/{timestamp}/distribution.json`
- Ecrit `data/distributions/{timestamp}/gauges/{vault}.json` (debug/audit)
- Ajoute une entree dans `data/distribution.json` avec `sentOnchain: false`
- Met a jour `data/incentives.json` :
  - `distributedUntil = windowEnd` pour chaque incentive traite
  - `ended = true` si `currentTimestamp >= incentive.end`

---

## Etape 3 - Generation du Merkle tree

**Fichiers** : `3_merkle.ts`, `utils/merkle.ts`

### 3.1 Combinaison des distributions (`createCombineDistribution`)

Le merkle est **cumulatif** : chaque run ajoute les nouvelles rewards aux montants precedents.

**Etapes** :

1. **Conversion** de la distribution courante en format `{ user -> { token -> amount } }` :
   - Pour chaque incentive, pour chaque user, additionne les montants par token
   - Normalise toutes les adresses au format checksum

2. **Redirection des dettes** (si `data/debts.json` existe) :
   - Pour chaque user endette, pour chaque token avec dette :
     ```
     redirect = min(newReward, debt)
     user.amount -= redirect
     treasury.amount += redirect
     debt -= redirect
     ```
   - Si la dette est entierement remboursee, supprime l'entree
   - Les rewards sont redirigees vers `TREASURY_ADDRESS`

3. **Merge avec l'ancien merkle** :
   - Pour chaque `(user, token)` dans l'ancien merkle :
     ```
     nouveau_montant = ancien_montant + nouveau_montant_distribution
     ```
   - Le resultat est donc toujours monotone croissant

### 3.2 Construction de l'arbre (`generateMerkleTree`)

**Format des feuilles** (double hash pour protection second preimage) :
```
leaf = keccak256(
    solidityPack(["bytes"], [
        keccak256(abi.encode(["address", "address", "uint256"], [user, token, amount]))
    ])
)
```

**Arbre** : `MerkleTree` de la lib `merkletreejs` avec `sortPairs: true` et `keccak256` comme hash.

**Proofs** : generes pour chaque `(user, token)` et stockes dans la structure `MerkleData`.

### 3.3 Structure du MerkleData

```typescript
{
    merkleRoot: "0x...",
    claims: {
        "0xUserAddress": {
            tokens: {
                "0xTokenAddress": {
                    amount: "123456789",     // montant cumulatif total
                    proof: ["0x...", ...]     // merkle proof
                }
            }
        }
    }
}
```

### 3.4 Finalisation

- Normalise toutes les adresses au format checksum (viem `getAddress`)
- Ecrit `data/distributions/{timestamp}/merkle.json`
- Ecrit `data/last_merkle.json`
- Met `sentOnchain: true` dans `data/distribution.json`
- Met a jour `data/debts.json` (dettes restantes ou suppression si tout est rembourse)

---

## Etape 4 - Verification et simulation

**Fichier** : `4_check.ts`

### 4.1 Chargement et preparation

1. Charge `data/last_merkle.json`
2. Charge `data/debts.json` si existant, agrege les dettes par token
3. Flatten tous les claims en `(user, token, totalAmount, proof[])`
4. Compare la root du JSON avec la root on-chain (`root()`)

### 4.2 Fetch des donnees on-chain (multicall)

Trois multicalls paralleles :
- `claimed(user, token)` pour chaque claim → montants deja reclames
- `decimals()` pour chaque token distinct → decimales pour affichage
- `balanceOf(MERKL_CONTRACT)` pour chaque token distinct → balance du contrat

### 4.3 Verification de solvabilite

Pour chaque token :
```
totalInMerkle   = sum(claim.totalAmount pour ce token)
alreadyClaimed  = sum(claimed[user][token])
pending         = totalInMerkle - alreadyClaimed
adjustedPending = pending - knownDebt[token]

FAIL si contractBalance < adjustedPending
```

### 4.4 Detection de regression

Pour chaque `(user, token)` :
```
if claim.totalAmount < onchain.claimed:
    ERREUR: regression detectee
    (le merkle propose un montant inferieur a ce qui a deja ete claim)
```

Log le diff et l'accumule par token pour le rapport.

### 4.5 Simulation des claims

Pour chaque claim avec `claimableDelta > 0` :
- Encode le calldata `claim(user, token, totalAmount, proof)`
- Si la root on-chain differe de la root du JSON, utilise `stateDiff` pour overrider le slot 0 du contrat avec la nouvelle root
- Execute `eth_call` avec `from: user`
- Decode le resultat
- Compte les succes/echecs/skips (deja full claim)

**Exit code** : `process.exit(1)` si au moins un claim echoue en simulation.

---

## Etape 0 (optionnel) - Patch des overclaims

**Fichier** : `5_patch.ts`

Execute **avant** une nouvelle distribution pour corriger les incoherences merkle/on-chain.

### Flux

1. Charge `data/last_merkle.json`
2. Flatten en `(user, token, amount)`
3. Multicall `claimed(user, token)` par batchs de 500
4. Pour chaque paire ou `claimed > amount` :
   - Patch : `amount = claimed` (le montant dans le merkle est augmente au niveau du claimed)
   - Enregistre la dette : `debt = claimed - amount`
5. Si des patches sont necessaires :
   - Ecrit `data/debts.json` (si n'existe pas deja)
   - Ecrit `data/initial_debts.json` (snapshot de reference)
   - Affiche le rapport de deficit par token (montant que la treasury doit deposer)
   - Regenere le merkle tree
   - Ecrit `data/last_merkle.json`, le merkle de la derniere distribution, et `data/patched_merkle.json`

### Cycle de remboursement des dettes

Les dettes sont remboursees progressivement via le mecanisme de redirection dans `createCombineDistribution` (etape 3) :
```
A chaque distribution :
    pour chaque user endette :
        redirect = min(nouvelle_reward, dette_restante)
        user.reward -= redirect
        treasury.reward += redirect
        dette -= redirect
```

---

## Infrastructure technique

### RPC (`utils/rpc.ts`)

- Multi-chain configure (mainnet, BSC, Optimism, Polygon, Sonic, Fraxtal, Base, Arbitrum, Hemi)
- Selection automatique du RPC le plus rapide via test de latence concurrent
- Cache des clients avec health check
- Fallback avec timeout etendu (60s) si tous les endpoints echouent
- Support Tenderly fork pour tests

### Serialisation (`utils/parse.ts`)

- `safeStringify` : gere les BigInt (convertis en string)
- `safeParse` : reconvertit les strings numeriques en BigInt (pattern `/^\d+n?$/`)

### Schema du flux complet

```
Contrat Merkl on-chain (incentives, claimed, root)
       |
       v
[1] Fetch incentives -----> data/incentives.json
       |
       v
[2] Distribution (TWAB)
    |-- Decouverte holders (Etherscan API)
    |-- Balances initiales (multicall balanceOf)
    |-- Replay Transfer logs (getLogs)
    |-- computeTwabSnapshots
    |-- Expansion wrappers (Morpho sub-TWAB)
    |-----> data/distributions/{ts}/distribution.json
    |-----> data/distributions/{ts}/gauges/{vault}.json
       |
       v
[3] Merkle tree
    |-- Merge cumulatif (ancien merkle + nouvelle distribution)
    |-- Redirection dettes vers treasury
    |-- generateMerkleTree (double hash, sortPairs)
    |-----> data/distributions/{ts}/merkle.json
    |-----> data/last_merkle.json
       |
       v
[4] Verification
    |-- Solvabilite (balance contrat >= pending - dettes)
    |-- Integrite (totalAmount >= claimed)
    |-- Simulation claims (eth_call + stateDiff)
    |-----> exit 0 (OK) ou exit 1 (echec)
       |
       v
Publication de la nouvelle root on-chain (hors scope)
```
