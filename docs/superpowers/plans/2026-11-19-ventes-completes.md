# Toutes les ventes, valeur récente et depuis toujours — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** garder et faire circuler toutes les ventes de chaque carte, et calculer une valeur récente (7 jours) et une valeur depuis toujours, la récente comptant quand elle repose sur assez de ventes.

**Architecture :**
- `keepAll` remplace les plafonds par rareté ; les relevés Pro et ceux du pool s'additionnent.
- `priceOf` calcule les deux médianes et retient la bonne dans `med`, que tout le reste lit déjà.
- Le serveur renvoie toutes les ventes, et `poolFlush` coupe les lots par taille.

**Tech stack :** userscript sans dépendance, Node 24 (`node:sqlite`), `node:test`.

**Spec :** `docs/superpowers/specs/2026-11-19-ventes-completes-design.md`

**Branche :** `claude/ventes-completes`, partie de `claude/amis-pool` (PR #14), à rebaser sur `main` après sa fusion.

## Global Constraints

- `MAX_SALES_PER_CARD = 2000` (script et réponses du pool), `RECENT_DAYS = 7`, `RECENT_MIN = 3`.
- Dédoublonnage d'une vente par `(rareté, date normalisée ISO, prix)`.
- Envoi d'un relevé Pro : les 200 ventes les plus récentes (`LIMITS.proSales = 200`). Lots de `poolFlush` : JSON de 1,5 Mo au plus.
- `trimHistory`, le garde-fou du mode secours, reste à 10 ventes par rareté (`keepPerRarity`).
- Versions : script `1.27.0`, serveur `1.3.0`.
- Texte de la colonne Valeur quand la récente compte : la valeur suivie de `' · 7 j'`.

## Review Focus

1. **La même vente avec deux écritures de date** (`…10:00:00Z` et `…10:00:00.000Z`, venues du site et du pool) : comptée une seule fois. Testé dans la tâche 1.
2. **Le mode secours (`localStorage`)** raccourcit toujours l'historique quand le navigateur est plein. Testé dans la tâche 1.
3. **Des ventes récentes, mais d'une autre rareté seulement** : elles ne font pas une valeur récente pour cette rareté. Testé dans la tâche 2.
4. **Une vente vieille d'exactement 7 jours** : elle compte encore comme récente (`<= 7 j`). Testé dans la tâche 2.
5. **Une carte au-delà de 2 000 ventes** : les plus récentes sont gardées, et le calcul reste immédiat. Testé dans la tâche 1.

---

### Task 1 : garder toutes les ventes, et les additionner

**Files :** Modify `wikimasters-stats.user.js` (`keepPerRarity` l. 392, `ingestSales` l. 490-500, `mySales` l. 485, `addObserved` l. 637, `mergePro` l. 777-795) ; Create `test/ventes-completes.test.js` ; Modify `test/harness.js` (`EXPOSE`)

**Interfaces :**
- Produces : `const MAX_SALES_PER_CARD = 2000` ; `function keepAll(list: Sale[]): Sale[]` (triées de la plus récente à la plus ancienne, dédoublonnées, 2 000 au plus) ; `function saleKey(s): string`.
- Ajouter `'keepAll'` à `EXPOSE`.

- [ ] **Step 1 : tests qui échouent** (`test/ventes-completes.test.js`) :
  - `keepAll : trie, dédoublonne, plafonne à 2 000` :
    - deux fois la même vente, l'une en `…10:00:00Z` et l'autre en `…10:00:00.000Z`, en donne une seule ;
    - le résultat est trié du plus récent au plus ancien ;
    - 2 001 ventes en donnent 2 000, la plus ancienne en moins.
  - `relevés Pro qui s'accumulent` :
    - `ingestSales('C1', { sales: [3 ventes A, B, C] })`, puis `ingestSales('C1', { sales: [C, D, E] })` → 5 ventes dans `db.prices.C1.sales` ;
    - `ingestSales('C1', { sales: [] })` → toujours 5.
  - `plus de plafond par rareté` : `ingestSales` de 75 ventes L → 75 gardées.
  - `mergePro : union des ventes, auteur du relevé le plus récent` :
    - `db.prices.C1` a 3 ventes à toi (`at` 1000) ; `mergePro([[ 'C1', 2000, [[p, t, 'L']×2, dont 1 commune] ]], 'Paul')` → 4 ventes, `at` 2000, `by` `'Paul'` ;
    - un `mergePro` plus ancien (`at` 500) ajoute ses ventes inconnues sans changer `at` ni `by`.
  - `mode secours : trimHistory raccourcit toujours` : 30 ventes L → `trimHistory()` → 10.
- [ ] **Step 2 : vérifier l'échec** : `node --test test/ventes-completes.test.js` → FAIL.
- [ ] **Step 3 : implémenter.**
  - `saleKey(s)` = `(s.r || '') + '|' + ISO(s.t) + '|' + s.p`, avec ISO = `new Date(Date.parse(s.t)).toISOString()` quand la date se lit, sinon `s.t`.
  - `keepAll` sert à `ingestSales` (union avec `db.prices[id].sales`), à `mySales`, à `addObserved` et à `mergePro`.
  - `mergePro` ne saute plus un relevé plus ancien : il ajoute ses ventes. `at` et `by` ne changent que si le relevé est plus récent. Le cas « tes propres prix revenus par un ami ne sont pas partagés » reste comme aujourd'hui.
  - Les anciens tests qui supposaient « le relevé le plus récent remplace » ou les plafonds 20/10/60 en dehors de `trimHistory` sont mis à jour, avec un `Ruling:` pour chacun.
- [ ] **Step 4 : vérifier** : `node --test test/*.test.js` → tout passe.
- [ ] **Step 5 : commit** (« Toutes les ventes : plus de plafond par rareté, les relevés s'additionnent »).

### Task 2 : valeur récente et depuis toujours

**Files :** Modify `wikimasters-stats.user.js` (`priceOf` l. 1263) ; Test `test/ventes-completes.test.js`

**Interfaces :**
- Consumes : `keepAll` (tâche 1).
- Produces :
  - `const RECENT_DAYS = 7, RECENT_MIN = 3` ;
  - `priceOf` renvoie en plus `medAll`, `nAll`, `medRecent` (`null` sans vente récente), `nRecent` et `basis: 'recent' | 'all'` ;
  - `med`, `n`, `sales`, `avg`, `min`, `max`, `last`, `rel` et `trend` portent sur l'ensemble retenu.

- [ ] **Step 1 : tests qui échouent** :
  - `la récente compte quand il y a assez de ventes` : 4 ventes L à 100 dans les 7 jours et 30 ventes L à 300 plus anciennes → `med` 100, `n` 4, `basis` `'recent'`, `nRecent` 4, `medAll` 300, `nAll` 34.
  - `pas assez de ventes récentes : depuis toujours` : 2 ventes récentes à 100 et 30 anciennes à 300 → `med` 300, `basis` `'all'`, `medRecent` 100, `nRecent` 2.
  - `une vente d'exactement 7 jours compte encore` : 3 ventes à `now - 7 j` → `basis` `'recent'`.
  - `récentes d'une autre rareté : pas de valeur récente ici` : 5 ventes UR récentes et 10 ventes L anciennes → `priceOf(id, 'L')` donne `basis` `'all'` et `nRecent` 0.
- [ ] **Step 2 : vérifier l'échec.**
- [ ] **Step 3 : implémenter.** Après le choix de la source et de la rareté (inchangé), découper ses ventes en récentes (`now - Date.parse(t) <= 7 j`) et toutes, puis appliquer la règle. Les deux médianes sont calculées une fois et mises en cache comme aujourd'hui.
- [ ] **Step 4 : vérifier**, puis **commit** (« Prix : valeur récente (7 jours, 3 ventes) ou depuis toujours »).

### Task 3 : le pool fait circuler toutes les ventes (serveur 1.3.0)

**Files :** Modify `server/db.js` (`proRows`, `obsRows` l. 60-65), `server/validate.js` (`LIMITS`), `server/server.js` (`VERSION`), `server/README.md` (version attendue) ; `wikimasters-stats.user.js` (`proEntry` l. 926, `poolFlush`) ; Test `test/server-db.test.js`, `test/server-http.test.js`, `test/pool-client.test.js`

**Interfaces :** `pullCards` inchangé dans sa forme : il renvoie juste plus de ventes.

- [ ] **Step 1 : tests qui échouent** :
  - Serveur :
    - `pull : toutes les ventes d'une rareté (plus de 20)` : 75 ventes Pro L et 75 observées L → `pullCards` en renvoie 75 de chaque ;
    - `pull : 2 000 au plus` : 2 500 ventes Pro → 2 000, les plus récentes ;
    - `push : jusqu'à 200 ventes par relevé Pro` : un relevé de 250 ventes en garde 200 ;
    - version `1.3.0`.
  - Client :
    - `relevé Pro envoyé : les 200 plus récentes` : `db.prices.C1` a 500 ventes ; après `poolFlush`, l'entrée Pro du corps envoyé en a 200, en commençant par la plus récente ;
    - `lots coupés à 1,5 Mo` : 40 relevés Pro de 200 ventes à titres longs (un JSON de plus de 1,5 Mo) → au moins deux envois `/v1/push`, chacun d'au plus 1,5 Mo, et la file vide à la fin.
- [ ] **Step 2 : vérifier l'échec.**
- [ ] **Step 3 : implémenter.**
  - `proRows` et `obsRows` : `ORDER BY sold_at DESC LIMIT 2000`, sans partition par rareté.
  - `LIMITS.proSales = 200`.
  - `proEntry` prend `p.sales.slice(0, 200)` (déjà triées).
  - `poolFlush` : il ajoute les entrées une à une en suivant la taille du JSON, et s'arrête avant 1,5 Mo (`POOL_BATCH_BYTES = 1.5e6`). Les plafonds par type (`POOL_BATCH`) restent.
- [ ] **Step 4 : vérifier**, puis **commit** (« Pool 1.3.0 : toutes les ventes en réponse, 200 par relevé envoyé, lots de 1,5 Mo »).

### Task 4 : afficher les deux valeurs, version et documentation

**Files :** Modify `wikimasters-stats.user.js` (`COLS` l. 2707, `badgeFor` l. 4536, colonne « Valeur médiane » des Souhaits l. 3716, l. 4 et 50), `README.md` (« Comment lire les chiffres », « Prix observés ») ; Test `test/ventes-completes.test.js`

**Interfaces :** Consumes : `priceOf` (`medAll`, `nAll`, `medRecent`, `nRecent`, `basis`).

- [ ] **Step 1 : tests qui échouent** :
  - `pastille : les deux valeurs` : la carte de la tâche 2, cas récent → `badgeFor(...).lines` contient `/Valeur : 100 ₩ \(7 derniers jours, 4 ventes/` et `/Depuis toujours : 300 ₩ \(34 ventes\)/`. Cas « depuis toujours » → `/Valeur : 300 ₩ \(depuis toujours, 32 ventes/` et `/7 derniers jours : 100 ₩ \(2 ventes\)/`.
- [ ] **Step 2 : vérifier l'échec.**
- [ ] **Step 3 : implémenter.**
  - `COLS` :
    - la colonne « Valeur » ajoute `' · 7 j'` quand `basis` vaut `'recent'` ;
    - deux nouvelles colonnes, `{ k: 'recent', t: '7 jours', price: true }` et `{ k: 'all', t: 'Depuis toujours', price: true }`, placées après « Valeur ». Cellule : `fmt(med) + ' ₩ · ' + plural(n, 'vente', 'ventes')`, ou `'—'`. Tri sur la médiane.
  - `badgeFor` : la ligne « Valeur médiane : … » devient « Valeur : X ₩ (7 derniers jours | depuis toujours, n ventes…) », suivie de la ligne de l'autre valeur quand elle existe.
  - La bulle de la colonne « Valeur médiane » des Souhaits dit la règle des 7 jours, et la cellule ajoute `' · 7 j'` comme la Collection.
  - Version `1.27.0`.
  - README : la règle (7 jours si au moins 3 ventes à cette rareté, sinon depuis toujours), les deux colonnes, et l'historique qui s'accumule sans plafond (garde-fou de 2 000 par carte).
- [ ] **Step 4 :** `node --test test/*.test.js` → tout passe. Faire un essai de montage jetable (la Collection avec les deux colonnes).
- [ ] **Step 5 : commit** (« v1.27.0 : valeur récente et depuis toujours, toutes les ventes »).
