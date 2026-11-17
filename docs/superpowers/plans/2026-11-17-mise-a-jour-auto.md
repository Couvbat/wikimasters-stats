# Mise à jour automatique — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** une routine qui garde à jour la valeur de la collection et les prix des souhaits, en relisant les prix selon leur poids, et un bouton « Tout mettre à jour maintenant ».

**Architecture :**
- `priceDue` remplace `priceStale` (délais par valeur et par rareté), et `dueCards()` trie ce qui est à relire par poids.
- `routinePass({ manual })` enchaîne les étapes de la conception avec un budget de requêtes. `autoRun` (le passage en arrière-plan) et `updateAll` (le bouton) l'appellent tous les deux.
- La lecture de la collection, de la liste de souhaits et la recherche d'une carte sont sorties des boutons pour être partagées.

**Tech stack :** userscript sans dépendance, `node:test`, harnais existant (faux `fetch`).

**Spec :** `docs/superpowers/specs/2026-11-17-mise-a-jour-auto-design.md`

**Branche :** `claude/mise-a-jour-auto`, partie de `main` après la fusion de la 1.24.0 (PR #11, `5a093b3`).

## Global Constraints

- **Délais de `priceDue`** :
  - 1 jour si la valeur connue est **> 50 ₩**, si la carte est en vente (`db.selling[].c`), ou si sa rareté est L ou UR ;
  - SR 2 jours, R 4 jours ;
  - PC, C et rareté inconnue : 7 jours ;
  - sans prix : à relire ;
  - historique vide d'une rareté de `DOUBT_EMPTY` : à relire au-delà d'une heure.
- **Poids** = valeur × exemplaires possédés (1 pour un souhait en vente non possédé). Valeur = médiane connue (`Math.max(med, DISCARD)`), sinon médiane des valeurs connues de la même rareté dans la collection, sinon 1.
- **Passage automatique** :
  - au plus toutes les 30 min, **aussi en arrière-plan** ;
  - `AUTO_BUDGET = 60` requêtes au site par passage, et `ALERTS_PER_PASS = 20` ;
  - la lecture des fins d'enchères qui termine le passage reste **hors budget**, comme aujourd'hui (règle du plan : la spec dit « comme aujourd'hui », et sans elle, la file des prix finaux ne serait plus alimentée).
- **Collection et liste** : relues en entier si `collectionFullAt`, ou le nouveau champ personnel `wishFullAt`, a plus de 24 h. Rien n'est remplacé si la lecture est incomplète. Après une collection relue, le passage s'arrête.
- **Verrou** `wmstats.auto` : `until = now + 2 min`, renouvelé à chaque requête ; `{ until: 0, at: now }` à la fin.
- **Bouton** : pas de budget, rythme `pace()`, Stop, `startJob` ; même verrou.
- **Textes** :
  - case : `'Mise à jour automatique'` (même clé `autoObs`, décochée par défaut) ;
  - bouton : `'Tout mettre à jour maintenant'` ;
  - ligne d'état : `'Dernière mise à jour automatique : il y a 12 min · 34 prix relus, 5 annonces vérifiées, 18 prix finaux. Encore 420 cartes à relire.'` (la dernière phrase seulement pour un compte Pro), ou `'Aucune mise à jour automatique pour l’instant.'`.
- **Version** : 1.25.0.

## Review Focus

1. **Collection lue à moitié** (erreur, Stop ou bouton lancé au milieu) : la collection n'est pas remplacée. Testé dans la tâche 2.
2. **Passage long, en arrière-plan** : le verrou est renouvelé, et un autre onglet ne démarre pas en même temps. Testé dans la tâche 2.
3. **Compte non Pro** : aucune requête `/sales`, ni dans le passage ni avec le bouton. Testé dans les tâches 2 et 3.
4. **Bouton manuel lancé pendant un passage** : le passage s'arrête (test existant « autoRun s'arrête dès qu'un relevé manuel démarre », à garder). Tâche 2.
5. **Carte jamais relue, et aucune valeur connue dans sa rareté** : poids 1, mais toujours à relire. Testé dans la tâche 1.

---

### Task 1 : `priceDue`, `dueCards`, et les boutons qui les suivent

**Files :** Modify `wikimasters-stats.user.js` (`priceStale` l. 1384 et ses 11 appels) ; Create `test/mise-a-jour-auto.test.js` ; Modify `test/harness.js` (`EXPOSE`)

**Interfaces :**
- Produces :
  - `const DUE_DAYS = { L: 1, UR: 1, SR: 2, R: 4, PC: 7, C: 7 }`, `const DUE_VALUE = 50` ;
  - `function dueDays(cardId: string, rarity: string): number` ;
  - `function priceDue(cardId: string, rarity: string): boolean`, qui remplace `priceStale` à tous ses appels (même signature, `priceStale` disparaît) ;
  - `function dueCards(): Array<[cardId: string, rarity: string, weight: number]>`, trié par poids décroissant : les cartes de la collection (paires carte et rareté, exemplaires additionnés) et les souhaits en vente (`askOf(id, r)`), dédoublonnés et filtrés par `priceDue`.
- Ajouter `'priceDue', 'dueCards', 'missingIds'` à `EXPOSE`.

- [ ] **Step 1 : tests qui échouent** (`test/mise-a-jour-auto.test.js`, avec `H = 36e5`) :
  - `priceDue : délais par rareté` :
    - L lue il y a 25 h → vrai, 23 h → faux ;
    - SR 47 h → faux, 49 h → vrai ;
    - R 3 j → faux, 5 j → vrai ;
    - C 6 j → faux, 8 j → vrai.
  - `priceDue : une carte qui vaut plus de 50 ₩ ou en vente se relit chaque jour` :
    - une R dont la médiane vaut 60, lue il y a 25 h → vrai ; la même à 40 → faux ;
    - une C en vente (`db.selling = [{ c: 'X', … }]`), lue il y a 25 h → vrai.
  - `priceDue : sans prix, et historique vide douteux` : pas de `db.prices[id]` → vrai ; une L avec `sales: []` lue il y a 2 h → vrai.
  - `dueCards : de la plus lourde à la plus légère` : A (médiane 10, 5 exemplaires, poids 50) et B (médiane 100, 1 exemplaire), toutes deux à relire → B avant A. Une R jamais lue, avec une autre R connue à 30 dans la collection → poids 30. Une PC jamais lue, sans aucune PC connue → poids 1, présente quand même.
  - `dueCards : les souhaits en vente comptent, une seule fois` : un souhait avec une annonce (`db.market.asks`) et sans prix est dedans ; possédé aussi, il n'apparaît qu'une fois.
  - `Relever les prix suit priceDue` : `missingIds()` ne contient pas une C relue il y a 3 jours, mais contient une L relue il y a 25 h (`ui.chosen` avec toutes les raretés).
- [ ] **Step 2 : vérifier l'échec** : `node --test test/mise-a-jour-auto.test.js` → FAIL (`t.priceDue` vaut `undefined`).
- [ ] **Step 3 : implémenter.** Remplacer `priceStale` par `priceDue` à ses 11 appels. La valeur connue vient de `priceOf(cardId, rarity)` (`n > 0`). Les médianes par rareté de `dueCards` se calculent une fois par appel.
- [ ] **Step 4 : vérifier** : `node --test test/*.test.js` → tout passe. Si un ancien test supposait « 24 h pour toutes les raretés », mettre à jour ses données et noter un `Ruling:`.
- [ ] **Step 5 : commit** (« Mise à jour auto : prix à relire selon leur valeur et leur rareté »).

### Task 2 : la routine et le passage en arrière-plan

**Files :** Modify `wikimasters-stats.user.js` (`loadCollection` l. 1464, `loadWish` l. 1722, `ingestWish` l. 436-440, `marketSearch`, `autoDue`/`autoRun` l. 1617-1667, `defaults`, `PERSONAL`) ; Test `test/mise-a-jour-auto.test.js` ; Modify `test/prix-sans-pro.test.js`

**Interfaces :**
- Consumes : `dueCards`, `priceDue` (tâche 1) ; `fetchSales`, `poolPrefetch`, `poolOn`, `alertsToCheck`, `finalsToFetch`, `ingestFinal`, `sweepUrls`, `sweepGroup`, `getJSON`, `proState` (existants).
- Produces :
  - `async function readCollection(stop: () => boolean): Promise<object[] | null>` : toutes les pages, ou `null` si interrompue ;
  - `async function readWishlist(stop): Promise<object[] | null>` : idem, pour la liste de souhaits ;
  - `async function searchCard(cardId, title): Promise<boolean>` : le corps d'une itération de `marketSearch` ; vrai si la carte est en vente ;
  - `db.wishFullAt` (personnel, `0` par défaut), posé par `ingestWish(…, true)` ;
  - `async function routinePass({ manual }): Promise<{ prices: number, alerts: number, finals: number, collection: boolean, wish: boolean }>` ;
  - `db.autoLast = { at, prices, alerts, finals, collection, wish }`.
- Ajouter `'routinePass'` à `EXPOSE`.

- [ ] **Step 1 : tests qui échouent.** Le harnais `fast: true` route les requêtes par motif d'URL. Sauf mention contraire, `collectionFullAt = wishFullAt = Date.now()`, et compte Pro (`db.userId = 'U1'`, `db.pro.U1 = true`).
  - `passage : 60 requêtes au plus, les plus lourdes d'abord` : 100 cartes C jamais lues, de médianes de rareté différentes (fixer les valeurs avec des cartes R connues). Après `autoRun()` : 60 requêtes `/sales` exactement, la première pour la carte la plus lourde, et `db.autoLast.prices === 60`.
  - `passage : 20 alertes au plus` : 30 alertes récentes sur des souhaits (`db.alerts`) → 20 requêtes `q=`.
  - `passage : le pool d'abord` : pool activé, dont `/v1/pull` renvoie un relevé Pro frais pour C1 → aucune requête `/sales` pour C1.
  - `passage : collection de plus de 24 h relue en entier, puis arrêt` : `collectionFullAt = 0`, `/api/my-collection` renvoie 50 cartes puis 10. Résultat : `db.cards` contient 60 exemplaires, aucune requête `/sales`, et `db.autoLast.collection === true`.
  - `passage : collection interrompue, rien n'est remplacé` : la page 2 répond 500 (pas une limite du site) → `db.cards` inchangé.
  - `passage : liste de souhaits de plus de 24 h relue` : `wishFullAt = 0` → requêtes `/api/cards?…wishlist=1`, puis `db.wishFullAt > 0`.
  - `passage : compte non Pro, aucune requête /sales` (`db.pro.U1 = false`).
  - `passage : limite du site, arrêt et pause de 24 h` : `/sales` répond 403 `{ code: 'automation_limit' }` → une seule requête `/sales`, et `db.autoPauseUntil > Date.now() + 23 * H`.
  - `passage : le verrou est renouvelé à chaque requête` : dans le faux `fetch`, lire `wmstats.auto` → `until >= Date.now() + 90e3` à chaque appel.
  - Dans `test/prix-sans-pro.test.js` :
    - `autoDue` : l'assertion « onglet en arrière-plan » devient `true` ;
    - `autoRun : 60 prix finaux…` : poser `collectionFullAt` et `wishFullAt` à maintenant (sinon la collection serait relue). Les 60 prix finaux et les 19 lectures de fins d'enchères restent attendus.
- [ ] **Step 2 : vérifier l'échec.**
- [ ] **Step 3 : implémenter.**
  - `readCollection` et `readWishlist` sortent la boucle de `loadCollection` et `loadWish`, qui les appellent avec `() => job.stop` et gardent leur affichage. `marketSearch` appelle `searchCard`.
  - `routinePass` suit l'ordre de la spec. Chaque requête au site passe par une petite fonction locale, qui compte la requête, renouvelle le verrou, puis attend : `pace()` si `manual`, `autoSleep()` sinon.
  - Le passage s'arrête quand le budget est épuisé (sauf pour les relectures complètes et la lecture finale des fins d'enchères), ou quand `stop()` est vrai : `job.stop` si `manual`, `job.running || job.stop` sinon. `automation_limit` est relancé à l'appelant.
  - `autoRun` = garde-fous actuels + `routinePass({ manual: false })` dans un `try`, puis `db.autoLast`, le verrou à 0 et `at` à maintenant, `saveDb` et `refresh`.
  - `autoDue` ne regarde plus `visibilityState`.
- [ ] **Step 4 : vérifier** : `node --test test/*.test.js` → tout passe.
- [ ] **Step 5 : commit** (« Mise à jour auto : la routine (collection, souhaits, alertes, prix, prix finaux), budget de 60 requêtes »).

### Task 3 : le bouton, la ligne d'état, la case

**Files :** Modify `wikimasters-stats.user.js` (`renderHome`/`e.view_home` l. 2668, groupe Réglages de `ovChk('autoObs'…)` l. 2809, `syncButtons`) ; Test `test/mise-a-jour-auto.test.js`

**Interfaces :**
- Consumes : `routinePass` (tâche 2), `dueCards` (tâche 1).
- Produces :
  - `async function updateAll(): Promise<void>` ;
  - `function autoLine(): string` ;
  - `e.updAll` (Accueil) et `e.updAll2` (Réglages), les deux boutons ;
  - `e.autoInfo` (Accueil) et `e.autoInfo2` (Réglages), les deux lignes d'état.
- Ajouter `'updateAll', 'autoLine'` à `EXPOSE`.

- [ ] **Step 1 : tests qui échouent** :
  - `bouton : pas de budget` : 100 cartes C jamais lues, compte Pro → après `updateAll()`, 100 requêtes `/sales` ; `job.running === false` ; `db.autoLast.prices === 100`.
  - `bouton : Stop arrête` : le faux `fetch` met `t.job.stop = true` à la 5e requête `/sales` → au plus 6 requêtes `/sales`.
  - `bouton : compte non Pro, aucune requête /sales`.
  - `ligne d'état` : avec `db.autoLast = { at: Date.now() - 12 * 6e4, prices: 34, alerts: 5, finals: 18 }`, et 420 cartes à relire en compte Pro, `autoLine()` correspond à `/^Dernière mise à jour automatique : il y a 12 min · 34 prix relus, 5 annonces vérifiées, 18 prix finaux\. Encore 420 cartes à relire\.$/`. Même chose en non Pro, mais sans la dernière phrase. Sans `autoLast` : `'Aucune mise à jour automatique pour l’instant.'`.
- [ ] **Step 2 : vérifier l'échec.**
- [ ] **Step 3 : implémenter.**
  - `updateAll` :
    - ne fait rien si `job.running` ;
    - sinon `startJob('Mise à jour : …')` et `writeAuto` (verrou), puis `routinePass({ manual: true })` ;
    - à la fin : `db.autoLast`, verrou à 0 et `at` à maintenant, puis `endJob` avec un résumé : `'Mise à jour terminée : 34 prix relus, 5 annonces vérifiées, 18 prix finaux.'`, ou `'Arrêtée : …'` après Stop. En cas d'erreur, `endJob` avec le message de l'erreur.
  - Placement :
    - l'Accueil reçoit une barre au-dessus de `homeTiles`, avec `btn('Tout mettre à jour maintenant', …, updateAll, 'pri')` et `e.autoInfo` ;
    - les Réglages reçoivent `e.updAll2` et `e.autoInfo2`, sous la case.
  - La case devient `'Mise à jour automatique'`, avec une bulle qui décrit les étapes, le budget, l'arrière-plan et la pause de 24 h.
  - `syncButtons` met à jour les deux lignes d'état et désactive les deux boutons pendant un `job.running`.
  - L'ancienne ligne « Dernier relevé automatique… » des Réglages est remplacée par `e.autoInfo2`.
- [ ] **Step 4 : vérifier**, puis **commit** (« Mise à jour auto : bouton Tout mettre à jour maintenant, ligne d'état »).

### Task 4 : version, documentation, vérification finale

**Files :** `wikimasters-stats.user.js` (l. 4 et 50) ; `README.md` (Réglages l. 57, « Prix observés » l. 228) ; `GUIDE.md` (premiers pas) ; ajouter au commit la spec et ce plan.

- [ ] **Step 1 :** `@version` et la valeur de secours de `VERSION` passent à `1.25.0`.
- [ ] **Step 2 :**
  - README, Réglages et « Prix observés » : la case « Mise à jour automatique » (ce qu'elle fait, dans l'ordre, et à quel rythme), le bouton, et les délais de relecture des prix (plus de 50 ₩, L et UR chaque jour ; SR 2 jours ; R 4 jours ; C et PC 7 jours).
  - GUIDE.md, une phrase : « Dans Réglages, coche “Mise à jour automatique” : le script garde tes prix à jour tout seul tant qu'un onglet du site est ouvert. »
- [ ] **Step 3 :** `node --test test/*.test.js` → tout passe.
- [ ] **Step 4 : commit** (« v1.25.0 : mise à jour automatique de la collection et des souhaits »).
