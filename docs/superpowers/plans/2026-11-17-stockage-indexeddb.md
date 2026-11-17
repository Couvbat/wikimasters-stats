# Stockage dans IndexedDB — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** ranger les données du script dans IndexedDB au lieu du `localStorage` (limité à 5 Mo), avec une migration vérifiée et sans perte.

**Architecture :** une couche `store` (cache des textes JSON en mémoire) devant deux modes : `'local'` (le `localStorage`, comme aujourd'hui, aussi utilisé en secours) et `'idb'` (base `wmstats`, magasin `kv`). `loadDb`, `setAccount` et la ligne des comptes lisent le cache de façon synchrone. `saveDb` y range un instantané, et une file d'écriture l'envoie à IndexedDB, une transaction à la fois. Au démarrage, une promesse `ready` retient les réponses du site, le montage du panneau et les minuteurs jusqu'au chargement.

**Tech stack :** userscript sans dépendance, IndexedDB, BroadcastChannel, `node:test` avec un faux `indexedDB` dans `test/harness.js`.

**Spec :** `docs/superpowers/specs/2026-11-17-stockage-indexeddb-design.md`

## Global Constraints

- **Base** : nom `wmstats`, version `1`, magasin `kv` (clés fournies à l'écriture). Valeurs : le texte JSON.
- **Clés** : les mêmes qu'aujourd'hui : `wmstats.v1` (partie commune), `wmstats.v1.u.<uid>` (partie personnelle, `wmstats.v1.u._` tant que le compte n'est pas reconnu). `wmstats.auto` reste dans le `localStorage` et n'est jamais effacé.
- **Canal entre onglets** : `BroadcastChannel('wmstats')`, message `{ saved: <identifiant de l'onglet> }`.
- **Aucune écriture avant le chargement** : `saveDb()` ne fait rien et renvoie `true` tant que `store.loaded` est faux.
- **Migration** : copie à l'identique de `wmstats.v1` et `wmstats.v1.u.*` en une transaction, relecture, comparaison texte par texte ; effacement du `localStorage` seulement si tout est identique, sinon mode `'local'`.
- **Textes** :
  - en-tête en mode `'idb'` : `' · ⚠ Enregistrement impossible : tes derniers changements ne sont pas enregistrés et seront perdus au rechargement de la page.'` ;
  - en mode `'local'`, l'avertissement actuel (« Navigateur plein ») ne change pas ;
  - onglet Sauvegarde : `'Rangées dans IndexedDB : 4,3 Mo.'` ou `'Rangées dans le stockage du site (limité à 5 Mo) : 4,3 Mo.'`.
  - Mo = (somme des longueurs des clés `wmstats.v1*` et de leurs textes) / 1e6, une décimale, virgule.
- **Sans `indexedDB`** (absent, `open` qui lève une exception, ou ouverture en erreur) : mode `'local'`, comportement de la 1.23.5 à l'identique. Les 123 tests existants passent sans changement.
- **Version** : 1.24.0.

## Review Focus

1. **`indexedDB.open` qui lève une exception** (mode de confidentialité strict) : le script passe en mode `'local'` sans planter. Testé dans la tâche 2.
2. **Message d'un autre onglet pendant que celui-ci a des écritures en attente** : il ne recharge pas, sinon ses propres changements seraient perdus. Testé dans la tâche 4.
3. **Réponse du site qui arrive avant la fin du chargement** : elle est traitée après, sans écraser ce qui a été chargé. Testé dans la tâche 3.
4. **Compte pas encore reconnu (`wmstats.v1.u._`) puis reconnu** : l'enregistrement `_` est effacé de la base. Testé dans la tâche 3.
5. **Écriture qui échoue puis réussit** : l'avertissement apparaît puis disparaît, et rien n'est perdu entre-temps. Testé dans la tâche 3.

---

### Task 1 : faux `indexedDB` dans le harnais et couche `store` en mode `'local'`

**Files :**
- Modify : `test/harness.js`
- Modify : `wikimasters-stats.user.js` (section stockage, l. 92-215 ; `accountLine` vers l. 2311 ; onglet Sauvegarde vers l. 2693)
- Create : `test/indexeddb.test.js`

**Interfaces :**
- Produces (harnais) :
  - `load({ idb })` crée un faux `indexedDB`, et un faux `BroadcastChannel`, seulement si `idb` est donné ;
  - `idb = { data?: Map<string,string>, bus?: object, gate?: Promise, failWrites?: () => boolean, corruptReads?: boolean, openThrows?: boolean }` ;
  - `load` renvoie en plus `ready` (la promesse du script), `idbData` (la `Map` de la base) et `idbStats` (`{ tx: number }`, le nombre de transactions `readwrite`) ;
  - `fakeBus()` (exporté) crée un bus partagé entre deux `load` pour simuler deux onglets ; `data` partagé simule un rechargement de page.
- Produces (script) :
  - `const store = { mode: 'local'|'idb', loaded: boolean, texts: Map<string,string>, pending: Map<string,string|null>, writing: boolean, idb: object|null, get(k): string|null, set(k, text): void, del(k): void, keys(): string[], size(): number, idle(): Promise<void> }` ;
  - `function storeLine(): string`.

- [ ] **Step 1 : faux `indexedDB`.** Dans le harnais, écrire le faux pour les seuls appels utilisés : `indexedDB.open(name, version)` → requête qui déclenche (de façon asynchrone, après `gate` s'il est donné) `onupgradeneeded` puis `onsuccess`, avec `result` = la base. La base fournit `objectStoreNames.contains`, `createObjectStore`, `transaction(nom, mode)`, `close` et `onversionchange`. La transaction fournit `objectStore` avec `get`, `put(valeur, clé)`, `delete`, `getAll` et `getAllKeys` (requêtes avec `onsuccess` et `result`), ainsi que `oncomplete`, `onerror`, `onabort` et `error`. Comportements à simuler :
  - `failWrites()` vrai : une transaction `readwrite` se termine par `onerror` et `onabort`, sans rien changer ;
  - `corruptReads` : `getAll` renvoie chaque texte suivi de `'x'` ;
  - `openThrows` : `open` lève une exception.

  Ajouter `'store', 'ready', 'storeLine', 'whenReady'` à `EXPOSE`.
- [ ] **Step 2 : tests qui échouent** (`test/indexeddb.test.js`) :
  - `mode local sans indexedDB : store.get lit le localStorage et storeLine le dit` : avec `storage: { 'wmstats.v1': '{"prices":{}}' }`, `t.store.mode === 'local'`, `t.store.loaded === true`, `t.store.get('wmstats.v1') === '{"prices":{}}'` et `t.storeLine()` correspond à `/^Rangées dans le stockage du site \(limité à 5 Mo\) : 0,0 Mo\.$/` ;
  - `mode local : la ligne des comptes compte les clés wmstats.v1.u.*, sans _` : avec les clés `.u.U1`, `.u.U2` et `.u._`, `t.store.keys().filter(...)` en donne 2.
- [ ] **Step 3 : vérifier l'échec** : `node --test test/indexeddb.test.js` → FAIL (`t.store` vaut `undefined`).
- [ ] **Step 4 : implémenter `store` en mode `'local'`.** `get`, `set`, `del` et `keys` passent par le `localStorage` ; `set` laisse passer l'erreur de quota, et `idle()` renvoie une promesse résolue. Remplacer ensuite les accès directs : `readJson(k)` lit `store.get(k)`, `setAccount` appelle `store.del(acctKey(''))`, et `accountLine` utilise `store.keys()`. `saveDb` en mode `'local'` garde son corps actuel (avec `localStorage` ou `store.set`/`get`, au choix). Ajouter `storeLine()`, et une ligne `h('p', { class: 'line' }, …)` sous « Tes données sont rangées dans ce navigateur… », rafraîchie dans `syncButtons`. Le mode initial vaut `'local'` quand `typeof indexedDB === 'undefined'`.
- [ ] **Step 5 : vérifier** : `node --test test/*.test.js` → les 125 tests passent.
- [ ] **Step 6 : commit** : `git add test/harness.js test/indexeddb.test.js wikimasters-stats.user.js && git commit` (message : « Stockage : couche store devant le localStorage, faux indexedDB pour les tests »).

### Task 2 : ouverture de la base, chargement et migration

**Files :** Modify `wikimasters-stats.user.js` (section stockage) ; Test `test/indexeddb.test.js`

**Interfaces :**
- Consumes : `store`, et le faux `indexedDB` de la tâche 1.
- Produces :
  - `function idbOpen(): Promise<object>` ;
  - `function idbReadAll(idb): Promise<Map<string,string>>` ;
  - `function idbWrite(idb, entries: Map<string, string|null>): Promise<void>` (`null` = effacer ; une seule transaction ; résolue sur `oncomplete`, rejetée sur `onerror`/`onabort`) ;
  - `const ready: Promise<void>`.

- [ ] **Step 1 : tests qui échouent** :
  - `migration de deux comptes` : `localStorage` avec `wmstats.v1` (`userId: 'U1'`, `prices`, `pool.url`), `wmstats.v1.u.U1` (cartes A), `wmstats.v1.u.U2` (cartes B) et `wmstats.auto`. Après `await ready` :
    - `t.store.mode === 'idb'` ;
    - `idbData` contient les trois clés, avec des textes **identiques** à l'origine ;
    - le `localStorage` ne contient plus que `wmstats.auto` ;
    - `t.db.cards` est celui de U1, et `t.db.pool.url` est conservé.
  - `migration de l'ancien format d'avant la 1.20` : `wmstats.v1` seul, avec `cards` dedans. Après `ready`, `idbData.get('wmstats.v1')` est identique et `t.db.cards` est rempli.
  - `relecture différente : rien n'est effacé, mode local` : avec `corruptReads`, `t.store.mode === 'local'`, le `localStorage` est intact et `t.db` vient du `localStorage`.
  - `base déjà remplie : elle fait foi, les clés restantes du localStorage sont effacées` : `idbData` contient `wmstats.v1` avec `pool.url = 'A'`, le `localStorage` contient `wmstats.v1` avec `pool.url = 'B'` et `wmstats.auto`. Résultat : `t.db.pool.url === 'A'`, `wmstats.v1` a disparu du `localStorage`, `wmstats.auto` est toujours là.
  - `open qui lève une exception : mode local, rien ne plante` (`openThrows`) : `t.store.mode === 'local'`, et `t.db` vient du `localStorage`.
  - `rien nulle part : défauts, mode idb`.
- [ ] **Step 2 : vérifier l'échec** : `node --test test/indexeddb.test.js` → FAIL.
- [ ] **Step 3 : implémenter.**
  - `idbOpen` : crée le magasin `kv` dans `onupgradeneeded`, et `onversionchange` ferme la base.
  - `idbReadAll` : `getAllKeys` et `getAll` dans une transaction `readonly`.
  - `idbWrite` : `put(texte, clé)` ou `delete(clé)`.
  - `ready` :
    - sans `indexedDB` : `store.loaded = true` **de façon synchrone**, puis `Promise.resolve()` ;
    - sinon, une fonction asynchrone qui suit les cas « Migration » de la spec. En cas d'erreur (`try/catch` autour de tout, y compris l'exception levée par `open`), elle passe en mode `'local'`.
    - dans tous les cas, elle termine par `db = loadDb()` puis `store.loaded = true`. En mode `'idb'`, `store.texts` reçoit le contenu lu, et `store.idb` la connexion.
  - Les clés `wmstats.v1*` sont effacées du `localStorage` par une fonction qui ne touche jamais `wmstats.auto`.
- [ ] **Step 4 : vérifier** : `node --test test/*.test.js` → tout passe.
- [ ] **Step 5 : commit** (« Stockage : base IndexedDB, chargement et migration vérifiée »).

### Task 3 : enregistrement dans la base, attente du chargement

**Files :** Modify `wikimasters-stats.user.js` (`saveDb`, `saveWarning`, hook de `fetch` l. 996-1046, `start` vers l. 4330, minuteurs vers l. 4021) ; Test `test/indexeddb.test.js`

**Interfaces :**
- Consumes : `store`, `idbWrite` et `ready` (tâches 1 et 2).
- Produces :
  - `function flushStore(): void` ;
  - `function whenReady(f: () => any): any`, qui appelle `f()` tout de suite si `store.loaded`, et sinon `ready.then(f)` ;
  - `store.idle()` en mode `'idb'` : se résout quand `pending` est vide et que rien ne s'écrit ;
  - `const TAB` (identifiant aléatoire de l'onglet) et `const channel`, qui vaut `new BroadcastChannel('wmstats')` si `typeof BroadcastChannel === 'function'`, et `null` sinon. `flushStore` y poste `{ saved: TAB }` après chaque succès.

- [ ] **Step 1 : tests qui échouent** :
  - `saveDb avant le chargement n'écrit rien` : base remplie (`pool.url = 'A'`), `gate` encore fermé. `t.saveDb()` renvoie `true`. On ouvre `gate`, on attend `ready` puis `store.idle()` : `idbData.get('wmstats.v1')` est inchangé et `t.db.pool.url === 'A'`.
  - `plusieurs saveDb dans la même tâche : une seule transaction` : trois `t.saveDb()` à la suite, `await t.store.idle()` → `idbStats.tx` augmente de 1.
  - `changement de compte : chaque compte garde son instantané` : U1 a la carte A. `t.setAccount('U2')`, puis `idle()` : `wmstats.v1.u.U1` contient A, `wmstats.v1.u.U2` existe et `t.db.cards` est vide.
  - `compte reconnu : l'enregistrement _ est effacé de la base` : `db.userId = ''`, puis `saveDb()` et `idle()` (`wmstats.v1.u._` présent). `setAccount('U1')` et `idle()` → `wmstats.v1.u._` absent, `wmstats.v1.u.U1` présent.
  - `écriture qui échoue puis réussit` : avec `failWrites` vrai, `saveDb()` puis `idle()` → `saveWarning()` correspond à `/Enregistrement impossible/`. Avec `failWrites` faux, `saveDb()` puis `idle()` → `saveWarning() === ''`, et `idbData` contient le dernier état.
  - `réponse du site avant le chargement : traitée après, sans écraser ce qui est chargé` : base avec des `prices` pour C1, `gate` fermé. `window.fetch('/api/marketplace?page=1')` répond `{ auctions: [annonce de C2] }`. On ouvre `gate`, puis `ready` et `idle()` : `t.db.prices.C1` est présent et `t.db.market.asks.C2` aussi.
- [ ] **Step 2 : vérifier l'échec.**
- [ ] **Step 3 : implémenter.**
  - `saveDb()` :
    - si `!store.loaded`, renvoie `true` sans rien faire ;
    - en mode `'idb'`, `splitDb()` et deux `store.set(...)` (le compte **au moment de l'appel**), puis renvoie `true` ;
    - en mode `'local'`, son corps actuel.
  - `store.set` et `store.del` en mode `'idb'` : mettent à jour `texts` et `pending` (`null` pour effacer), puis programment `flushStore` en micro-tâche, une seule fois par tâche.
  - `flushStore` :
    - s'il y a des écritures en attente et rien en cours, il prend tout `pending` et le vide, puis lance `idbWrite` ;
    - succès : `saveState.failed = 0`, message sur le canal, et une nouvelle écriture si `pending` s'est rempli entre-temps ;
    - échec : il remet dans `pending` les entrées qu'aucune plus récente n'a remplacées, puis `saveState.failed = Date.now()`, sans nouvel essai automatique.
  - `saveWarning` prend le texte `'idb'` des Global Constraints en mode `'idb'`.
  - `whenReady` enveloppe les traitements qui touchent `db` dans le hook : `ingestTags`, `ingestPro`, `onPull`, `ingestSales`, le bloc `ingestFinal`, `ingestCollection`, `ingestMarket`, `ingestTrades`, `ingestAlerts` et `ingestWish`.
  - `start` devient `() => whenReady(...)`. Les trois `setInterval` ne font rien tant que `!store.loaded`.
- [ ] **Step 4 : vérifier** : `node --test test/*.test.js` → tout passe.
- [ ] **Step 5 : commit** (« Stockage : enregistrement dans IndexedDB, une transaction à la fois, rien avant le chargement »).

### Task 4 : plusieurs onglets

**Files :** Modify `wikimasters-stats.user.js` (écouteur `storage` l. 145) ; Test `test/indexeddb.test.js`

**Interfaces :**
- Consumes : `TAB` et `channel` (tâche 3) ; `fakeBus()` du harnais.
- Produces : l'écouteur `channel.onmessage`.

- [ ] **Step 1 : tests qui échouent** :
  - `un autre onglet enregistre : celui-ci recharge` : deux `load` partagent `data` et `bus`, et tous deux attendent `ready`. Dans A, on pose `pool.url = 'X'`, puis `saveDb()` et `idle()` ; on attend un tour de boucle : `B.db.pool.url === 'X'`.
  - `écritures en attente : pas de rechargement` : B a une écriture en échec en attente (`failWrites` vrai pour B seulement). A enregistre `pool.url = 'X'` : `B.db.pool.url` reste la valeur de B.
  - `traitement en cours : pas de rechargement` (`job.running`).
- [ ] **Step 2 : vérifier l'échec.**
- [ ] **Step 3 : implémenter.** À la réception d'un message sur `channel`, l'onglet ne fait rien si l'une de ces conditions est vraie : mode `'local'`, `ev.data.saved === TAB`, `job.running`, `store.pending.size`, ou `store.writing`. Sinon, il appelle `idbReadAll(store.idb)`, remplace `store.texts`, puis `db = loadDb()`, `resetPrices()` et `refresh()`. L'écouteur `storage` actuel ne réagit plus qu'en mode `'local'`.
- [ ] **Step 4 : vérifier**, puis **commit** (« Stockage : les onglets se préviennent après chaque enregistrement »).

### Task 5 : version, documentation, vérification finale

**Files :** Modify `wikimasters-stats.user.js` (l. 4 et 50) ; `README.md` (section « Sauvegarde », l. 199-201) ; ajouter au commit la spec et ce plan.

- [ ] **Step 1 :** `@version` et la valeur de secours de `VERSION` passent à `1.24.0`.
- [ ] **Step 2 :** README, section Sauvegarde : une phrase sur l'endroit où les données sont rangées. Depuis la 1.24, c'est la base IndexedDB du navigateur, sans la limite de 5 Mo ; le passage se fait tout seul au premier chargement, et la ligne « Rangées dans IndexedDB » de l'onglet Sauvegarde le confirme. Conseil : recharger tous les onglets du site après la mise à jour.
- [ ] **Step 3 :** `node --test test/*.test.js` → tout passe. Relire le diff : aucun `localStorage.` restant hors du mode `'local'`, de `wmstats.auto` et de la migration.
- [ ] **Step 4 : commit** (« v1.24.0 : données rangées dans IndexedDB, sans la limite de 5 Mo »).
