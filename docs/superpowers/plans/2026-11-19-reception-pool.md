# Réception incrémentale de tout le pool — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** le script reçoit une première fois tout le pool, puis seulement ce qui a changé, toutes les 15 minutes et à l'ouverture du panneau.

**Architecture :**
- Le serveur expose un fil `GET /v1/feed` : les lignes des trois tables dont le numéro d'ordre (`rev`) dépasse `since`, page par page.
- Le script garde sa position dans `db.pool.feed`. Il fusionne chaque page avec les fonctions existantes (`mergePro`, `mergeObserved`) et retire les prix provisoires que le pool a retirés.
- Quand le fil sert, l'ancienne réception carte par carte se tait. Sinon (pool en 1.3.0, mode secours), elle reste comme avant.

**Tech stack :** userscript sans dépendance, Node 24 (`node:sqlite`), `node:test`.

**Spec :** `docs/superpowers/specs/2026-11-19-reception-pool-design.md`

**Branche :** `claude/reception-pool`, partie de `main` (c9cd6c8). Le plan commite à chaque tâche sur cette branche.

## Global Constraints

- **Versions :** script `1.28.0` (`@version` et repli de `VERSION`), serveur `1.4.0`.
- **Fil, côté serveur :** `limit` vaut 5 000 par défaut et 10 000 au plus. `since` est un entier ≥ 0. Une valeur invalide renvoie 400 `{ error }`.
- **Rythme du script :**
  - `POOL_FEED_EVERY = 15 * 6e4` entre deux passages automatiques ;
  - `POOL_FEED_MIN = 6e4` au moins entre deux passages non forcés ;
  - `POOL_FEED_PAGE = 5000` lignes par page.
- **Plafond des ventes observées :** 50 000 cartes en IndexedDB, 8 000 en mode secours (`localStorage`).
- **Vente Pro reçue sans la date de son relevé :** rangée avec la date `1`.
- **Rien n'est effacé chez soi sauf un prix observé provisoire** (sans `x`), retiré par une ligne `unsold` ou par une vente `pro` de la même enchère.
- **Textes de la ligne d'état du pool, exacts :**
  - `réception de tout le pool : N ventes reçues` (N formaté avec `fmt`) ;
  - `à jour ` + `ago(at)` ;
  - `ancienne méthode (pool en 1.3.0)`.
- **Commandes :** tests avec `node --test test/*.test.js`. Les commits finissent par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Le pool répond 200 avec un corps inattendu** (page d'erreur du tunnel, champ `next` manquant). Le passage échoue, la position ne bouge pas, et le recul habituel s'applique. Testé dans la tâche 5.
2. **La même adresse écrite avec ou sans `/` final** ne relance pas toute la réception. Testé dans la tâche 5.
3. **Une date de dernier passage dans le futur** (horloge changée) ne bloque pas les passages. Testé dans la tâche 6.
4. **Une ligne d'une sorte inconnue** (future version du serveur) est ignorée, sans erreur. Testé dans la tâche 4.
5. **Deux appels simultanés de `poolFeed`** (panneau ouvert pendant un passage automatique) font une seule série de requêtes. Testé dans la tâche 5.

---

### Task 1: Serveur — identifiant du pool et lecture du fil

**Files:**
- Modify: `server/db.js` (`migrate`, nouvelle fonction `feedRows`, `module.exports`)
- Test: `test/server-db.test.js`

**Interfaces:**
- Produces :
  - `feedRows(db, since: number, limit: number) → { pool: string, max: number, next: number, more: boolean, sales: Array, pro: Array, unsold: Array }`
  - lignes `sales` : `[rev, carte, prix, date, sorte ('pro'|'exact'|'prov'), enchère ('' si aucune), écart, rareté|null]`
  - lignes `pro` : `[rev, carte, at, auteur|null]`
  - lignes `unsold` : `[rev, enchère]`
  - `next` est le `rev` de la dernière ligne rendue, ou `since` si la page est vide. `max` est la valeur de `meta.rev`.
  - `getMeta(db, 'pool_id')` : 16 caractères hexadécimaux, créés une fois.

- [ ] **Step 1: Write the failing tests** in `test/server-db.test.js` (ajouter `feedRows` et `getMeta` à l'import) :

```js
test('fil : tout, dans l’ordre des numéros, page par page, sans trou ni doublon', () => {
  const db = openDb(':memory:');
  push(db, { member: 'Jules', pro: [['C1', now - 1000, [[50, T], [40, T3]]]] }); // rev 1, 2 (ventes), 3 (relevé)
  push(db, { member: 'Paul', sales: [['C2', 30, T, 10, 0, 'A1', 'SR']], unsold: ['A9'] }); // rev 4 (vente), 5 (unsold)
  const p1 = feedRows(db, 0, 3);
  assert.equal(p1.more, true);
  assert.equal(p1.next, 3);
  assert.equal(p1.max, 5);
  assert.deepEqual(p1.sales.map(r => r[0]), [1, 2]);
  assert.deepEqual(p1.pro, [[3, 'C1', now - 1000, 'Jules']]);
  const p2 = feedRows(db, p1.next, 3);
  assert.equal(p2.more, false);
  assert.equal(p2.next, 5);
  assert.deepEqual(p2.sales, [[4, 'C2', 30, T, 'prov', 'A1', 10, 'SR']]);
  assert.deepEqual(p2.unsold, [[5, 'A9']]);
  assert.deepEqual(feedRows(db, 5, 3), { pool: p1.pool, max: 5, next: 5, more: false, sales: [], pro: [], unsold: [] });
});

test('fil : un provisoire devenu final revient avec un numéro plus grand', () => {
  const db = openDb(':memory:');
  push(db, { member: 'A', sales: [['C1', 30, T, 10, 0, 'A1']] });
  const before = feedRows(db, 0, 100);
  push(db, { member: 'B', sales: [['C1', 45, T2, 0, 1, 'A1']] });
  const after = feedRows(db, before.next, 100);
  assert.equal(after.sales.length, 1);
  assert.equal(after.sales[0][4], 'exact');
  assert.equal(after.sales[0][2], 45);
  assert.ok(after.sales[0][0] > before.next);
});

test('fil : l’identifiant du pool est créé une fois et survit à la réouverture', () => {
  const file = path.join(os.tmpdir(), 'wm-feed-' + process.pid + '.db');
  const a = openDb(file);
  const id = getMeta(a, 'pool_id');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(feedRows(a, 0, 10).pool, id);
  a.close();
  const b = openDb(file);
  assert.equal(getMeta(b, 'pool_id'), id);
  b.close();
  for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
});
```

(Ajouter en tête : `const fs = require('node:fs'), os = require('node:os'), path = require('node:path');`.)

- [ ] **Step 2: Run tests to verify they fail**

Run : `node --test test/server-db.test.js`
Expected : FAIL, `feedRows is not a function`.

- [ ] **Step 3: Implement**
  - Dans `migrate`, ajouter `INSERT OR IGNORE INTO meta (k, v) VALUES ('pool_id', lower(hex(randomblob(8))))`.
  - Ajouter `feedRows` dans `server/db.js` :
    - trois `SELECT … WHERE rev > ? ORDER BY rev LIMIT ?` avec `limit + 1` (index `sales_rev`, `pro_fetch_rev`, `unsold_queue_rev` déjà en place) ;
    - fusionner par `rev`, puis garder les `limit` premières lignes ;
    - `more` = il en restait.
  - Exporter `feedRows`.

- [ ] **Step 4: Run tests to verify they pass**

Run : `node --test test/server-db.test.js`
Expected : PASS, y compris les tests existants.

- [ ] **Step 5: Commit**

```bash
git add server/db.js test/server-db.test.js docs/superpowers/specs/2026-11-19-reception-pool-design.md docs/superpowers/plans/2026-11-19-reception-pool.md
git commit -m "Pool 1.4.0 : lecture du fil des nouveautés (feedRows) et identifiant du pool"
```

### Task 2: Serveur — route `GET /v1/feed`, version 1.4.0

**Files:**
- Modify: `server/validate.js` (nouvelle fonction `parseFeedQuery`, export)
- Modify: `server/server.js` (`VERSION`, ensemble `routes`, branche de la route)
- Modify: `server/README.md` (« Les routes », version attendue dans « 6. Vérifier », rappel dans « Mise à jour »)
- Test: `test/server-http.test.js`

**Interfaces:**
- Consumes : `feedRows` (tâche 1).
- Produces :
  - `parseFeedQuery(params: URLSearchParams) → { since: number, limit: number }`, qui lève `httpError(400, …)` ;
  - la route `GET /v1/feed?since=&limit=`, qui demande la clé.

- [ ] **Step 1: Write the failing tests** in `test/server-http.test.js` :
  - Dans le test `health`, remplacer `'1.3.0'` par `'1.4.0'`.
  - Ajouter :

```js
test('fil : demande la clé, rend les pages, refuse les paramètres invalides', async () => {
  assert.equal((await req('GET', '/v1/feed?since=0')).status, 401);
  await req('POST', '/v1/push', { headers: auth, body: { member: 'Jules', sales: [['C1', 30, '2026-11-15T10:00:00.000Z', 0, 1, 'A1']] } });
  const r = await req('GET', '/v1/feed?since=0', { headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.json.sales.length, 1);
  assert.equal(r.json.sales[0][1], 'C1');
  assert.match(r.json.pool, /^[0-9a-f]{16}$/);
  assert.equal(r.json.more, false);
  assert.equal((await req('GET', '/v1/feed', { headers: auth })).status, 200, 'since absent : 0');
  for (const q of ['since=-1', 'since=abc', 'since=1.5', 'since=0&limit=0', 'since=0&limit=10001', 'since=99999999999999999999'])
    assert.equal((await req('GET', '/v1/feed?' + q, { headers: auth })).status, 400, q);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run : `node --test test/server-http.test.js`
Expected : FAIL. `/v1/feed` répond 404 `route inconnue`, et la version vaut 1.3.0.

- [ ] **Step 3: Implement**
  - **`parseFeedQuery`** :
    - `since` absent vaut 0, sinon il faut `/^\d+$/` et `Number.isSafeInteger` ;
    - `limit` absent vaut 5 000, sinon un entier de 1 à 10 000.
  - **Dans `server.js` :**
    - `VERSION = '1.4.0'` ;
    - ajouter `'GET /v1/feed'` à `routes` ;
    - avant `readJson`, `if (route === 'GET /v1/feed') { const q = parseFeedQuery(url.searchParams); return send(200, feedRows(db, q.since, q.limit)); }`.
  - **`server/README.md` :**
    - une ligne `GET /v1/feed`, « nouveautés depuis un numéro, 5 000 lignes par page (10 000 au plus) » ;
    - la version `1.4.0` dans « 6. Vérifier ».

- [ ] **Step 4: Run tests to verify they pass**

Run : `node --test test/server-*.test.js`
Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add server/validate.js server/server.js server/README.md test/server-http.test.js
git commit -m "Pool 1.4.0 : route GET /v1/feed"
```

### Task 3: Script — briques : plafond par mode, provisoire rendu exact, retrait des provisoires

**Files:**
- Modify: `wikimasters-stats.user.js`
  - `addObserved` et les constantes autour (~l. 640–665) ;
  - les deux tailles `MAX_OBS_CARDS` (`settleObserved` ~l. 693, `mergeObserved` ~l. 789).
- Modify: `test/harness.js` (ajouter à `EXPOSE` : `'obsCardsMax', 'dropProvisional'`)
- Test: `test/pool-feed.test.js` (nouveau)

**Interfaces:**
- Produces :
  - `obsCardsMax() → number` : 50 000 si `store.mode === 'idb'`, sinon 8 000. Remplace les deux usages de `MAX_OBS_CARDS`.
  - `dropProvisional(auctions: string[]) → number`. Pour chaque enchère :
    - retire de `db.obsSales` la vente **provisoire** (sans `x`) qui porte ce numéro ;
    - supprime `db.finQ[enchère]`.

    Elle renvoie le nombre de ventes retirées et appelle `resetPrices()` si ce nombre n'est pas nul.
  - `addObserved` : une vente exacte à la même date et au même prix qu'une provisoire déjà gardée la rend exacte (`x = 1`), avec l'écart de la vente exacte (0 pour un prix final), comme le fait le serveur. Elle lui donne aussi son numéro d'enchère s'il en manquait un, et renvoie `true`.

- [ ] **Step 1: Write the failing tests** in `test/pool-feed.test.js` :

```js
// Tests de la réception par le fil du pool (1.28.0). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');
const T = '2026-11-15T10:00:00.000Z';

test('plafond des ventes observées : 50 000 cartes en IndexedDB, 8 000 en mode secours', async () => {
  const idb = load({ idb: {} });
  await idb.ready;
  assert.equal(idb.t.obsCardsMax(), 50000);
  assert.equal(load().t.obsCardsMax(), 8000);
});

test('mode IndexedDB : plus de 8 000 cartes observées sont gardées', async () => {
  const { t, ready } = load({ idb: {} });
  await ready;
  const sales = Array.from({ length: 9000 }, (_, i) => ['K' + i, 10, T, 0, 1, '', null]);
  t.mergeObserved({ sales });
  assert.equal(Object.keys(t.db.obsSales).length, 9000);
});

test('un exact à la même date et au même prix rend exact le provisoire sans enchère', () => {
  const { t } = load();
  t.addObserved('C1', { p: 30, t: T, g: 5 }, null);
  assert.equal(t.addObserved('C1', { p: 30, t: T, g: 0, x: true, i: 'A1' }, null), true);
  assert.deepEqual(plain(t.db.obsSales.C1), [{ p: 30, t: T, g: 0, i: 'A1', x: 1 }]);
});

test('dropProvisional retire le provisoire et la file des prix finaux, jamais un exact', () => {
  const { t } = load();
  t.addObserved('C1', { p: 30, t: T, g: 5, i: 'A1' }, null);
  t.addObserved('C2', { p: 40, t: T, g: 0, i: 'A2', x: true }, null);
  t.db.finQ.A1 = ['C1', 'SR', Date.parse(T), 1];
  assert.equal(t.dropProvisional(['A1', 'A2', 'A3']), 1);
  assert.equal(t.db.obsSales.C1, undefined, 'carte vidée : retirée');
  assert.equal(t.db.obsSales.C2.length, 1);
  assert.equal(t.db.finQ.A1, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run : `node --test test/pool-feed.test.js`
Expected : FAIL. `t.obsCardsMax is not a function`, et le provisoire reste sans `x`.

- [ ] **Step 3: Implement**
  - `obsCardsMax`, à la place de la constante `MAX_OBS_CARDS = 8000` (garder 8 000 comme valeur du mode secours).
  - La règle « même date, même prix » de `addObserved`. Hors fusion en bloc, appliquer `keepAll` comme pour un ajout.
  - `dropProvisional` :
    - construire une fois un index enchère → carte sur les ventes provisoires ;
    - supprimer la carte de `db.obsSales` si sa liste devient vide.

- [ ] **Step 4: Run tests to verify they pass**

Run : `node --test test/*.test.js`
Expected : PASS, 213 tests existants et 4 nouveaux.

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js test/harness.js test/pool-feed.test.js
git commit -m "Script : plafond des ventes observées selon le stockage, provisoire rendu exact, retrait des provisoires"
```

### Task 4: Script — fusion d'une page du fil

**Files:**
- Modify: `wikimasters-stats.user.js` (section pool, après `poolPull`)
- Modify: `test/harness.js` (ajouter `'applyFeedPage'` à `EXPOSE`)
- Test: `test/pool-feed.test.js`

**Interfaces:**
- Consumes : `dropProvisional` (tâche 3), `mergePro(list, from)`, `mergeObserved({ sales })`, et le format de page de la tâche 1.
- Produces : `applyFeedPage(page) → number`, le nombre de ventes et de relevés qui ont apporté quelque chose (comme `poolPull`). La fonction ne touche ni à la position ni à l'enregistrement.

- [ ] **Step 1: Write the failing tests** in `test/pool-feed.test.js` :

```js
const page = (o = {}) => Object.assign({ pool: 'p1', max: 0, next: 0, more: false, sales: [], pro: [], unsold: [] }, o);

test('page : ventes Pro avec leur relevé, ventes observées, sorte inconnue ignorée', () => {
  const { t } = load();
  const n = t.applyFeedPage(page({
    sales: [[1, 'C1', 50, T, 'pro', '', 0, 'SR'], [2, 'C2', 30, T, 'prov', 'A1', 4, null], [3, 'C3', 9, T, 'futur', '', 0, null]],
    pro: [[4, 'C1', 1700000000000, 'Paul']]
  }));
  assert.ok(n >= 2);
  assert.deepEqual(plain(t.db.prices.C1), { at: 1700000000000, sales: [{ p: 50, t: T, r: 'SR' }], by: 'Paul' });
  assert.deepEqual(plain(t.db.obsSales.C2), [{ p: 30, t: T, g: 4, i: 'A1' }]);
  assert.equal(t.db.obsSales.C3, undefined);
  assert.equal(t.db.prices.C3, undefined);
});

test('page : vente Pro sans son relevé rangée à la date 1, puis la date arrive seule', () => {
  const { t } = load();
  t.applyFeedPage(page({ sales: [[1, 'C1', 50, T, 'pro', '', 0, null]] }));
  assert.equal(t.db.prices.C1.at, 1);
  t.applyFeedPage(page({ pro: [[2, 'C1', 1700000000000, 'Paul']] }));
  assert.equal(t.db.prices.C1.at, 1700000000000);
  assert.equal(t.db.prices.C1.by, 'Paul');
  assert.equal(t.db.prices.C1.sales.length, 1);
  t.applyFeedPage(page({ pro: [[3, 'C9', 1700000000000, 'Paul']] }));
  assert.equal(t.db.prices.C9, undefined, 'pas de relevé vide');
});

test('page : unsold et vente Pro d’une enchère retirent le provisoire', () => {
  const { t } = load();
  t.addObserved('C1', { p: 30, t: T, g: 5, i: 'A1' }, null);
  t.addObserved('C2', { p: 20, t: T, g: 5, i: 'A2' }, null);
  t.applyFeedPage(page({ unsold: [[1, 'A1']], sales: [[2, 'C2', 25, T, 'pro', 'A2', 0, null]] }));
  assert.equal(t.db.obsSales.C1, undefined);
  assert.equal(t.db.obsSales.C2, undefined);
  assert.equal(t.db.prices.C2.sales[0].p, 25);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run : `node --test test/pool-feed.test.js`
Expected : FAIL, `t.applyFeedPage is not a function`.

- [ ] **Step 3: Implement `applyFeedPage(page)`**
  - **Ventes Pro :**
    - les grouper par carte en entrées `mergePro` `[carte, at, [[prix, date, rareté]…], auteur]` ;
    - `at` et l'auteur viennent de la ligne `pro` de la carte dans la page, sinon `at = 1` et l'auteur vide (`mergePro` mettra `groupe`).
  - **Lignes `pro` sans vente dans la page :**
    - si `db.prices[carte]` a des ventes et une date plus ancienne, passer à `mergePro` l'entrée `[carte, at, ventes déjà connues en tableaux, auteur]` ;
    - sinon, ne rien faire.
  - **Ventes `exact` et `prov` :** les passer à `mergeObserved`, par paquets de 20 000, au format `[carte, prix, date, écart, x, enchère, rareté]`.
  - **Retraits :** passer à `dropProvisional` les enchères des lignes `unsold` et celles des ventes `pro` qui ont un numéro d'enchère.
  - **Sorte inconnue ou ligne mal formée :** ignorée.
  - Valider chaque champ comme `poolPull` le fait (`okKey`, `num`).

- [ ] **Step 4: Run tests to verify they pass**

Run : `node --test test/*.test.js`
Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js test/harness.js test/pool-feed.test.js
git commit -m "Script : fusion d'une page du fil du pool"
```

### Task 5: Script — le passage : pages, position, reprises, repli

**Files:**
- Modify: `wikimasters-stats.user.js`
  - `defaults()` (~l. 42) : `pool.feed` ;
  - constantes du pool (~l. 912) ;
  - nouvelles fonctions `feedOn` et `poolFeed`.
- Modify: `test/harness.js` (ajouter `'feedOn', 'poolFeed'` à `EXPOSE`)
- Test: `test/pool-feed.test.js`

**Interfaces:**
- Consumes : `applyFeedPage` (tâche 4), `poolFetch`, `poolFailed`, `poolOk`, `saveDb`, `resetPrices`.
- Produces :
  - `db.pool.feed = { url: '', pool: '', rev: 0, at: 0, off: 0, got: 0 }`, dans `defaults()` et complété au chargement d'une base plus ancienne :
    - `url` : l'adresse normalisée, sans `/` final ;
    - `at` : la fin du dernier passage réussi ;
    - `off` : la date du dernier 404 ;
    - `got` : les ventes reçues depuis la position 0.
  - `feedOn() → boolean` : `poolOn()`, `store.mode === 'idb'`, et pas de 404 noté depuis moins de 6 h (`POOL_PULL_EVERY`) **pour cette adresse**.
  - `poolFeed(force?: boolean) → Promise<number>` : le nombre apporté (somme des `applyFeedPage`).
    - Un seul passage à la fois. Un second appel pendant un passage renvoie 0 sans requête.
    - Sans `force`, rien si le dernier passage a moins de `POOL_FEED_MIN`. Une date de dernier passage dans le futur ne compte pas : le passage a lieu.

- [ ] **Step 1: Write the failing tests** in `test/pool-feed.test.js`. Ajouter un pool simulé qui sert un fil à partir d'une liste de lignes :

```js
const POOL = 'https://pool.test', KEY = 'cle-du-groupe-assez-longue-123';
// rows : [[table, rev, ...champs]] ; state : { pool, fail(since), status (du fil seulement), body }.
function feedEnv(rows, state = {}) {
  const calls = [];
  const fetch = async url => {
    if (!url.startsWith(POOL)) return reply({});
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname === '/v1/pull') return reply({ cards: {} });
    if (u.pathname === '/v1/profiles') return reply({ profiles: [] });
    if (u.pathname !== '/v1/feed') return reply({ error: 'route' }, 404);
    if (state.status) return reply({ error: 'x' }, state.status);
    const since = Number(u.searchParams.get('since')), limit = Number(u.searchParams.get('limit'));
    if (state.fail && state.fail(since)) throw new TypeError('Failed to fetch');
    if (state.body) return reply(state.body);
    const todo = rows.filter(r => r[1] > since).sort((a, b) => a[1] - b[1]);
    const part = todo.slice(0, limit), last = part.length ? part[part.length - 1][1] : since;
    const pick = k => part.filter(r => r[0] === k).map(r => r.slice(1));
    return reply({ pool: state.pool || 'p1', max: rows.reduce((m, r) => Math.max(m, r[1]), 0), next: last, more: todo.length > limit,
      sales: pick('s'), pro: pick('p'), unsold: pick('u') });
  };
  return { fetch, calls };
}
async function feedLoad(rows, state) {
  const f = feedEnv(rows, state);
  const env = load({ idb: {}, fast: true, fetch: f.fetch });
  await env.ready;
  Object.assign(env.t.db.pool, { url: POOL + '/', key: KEY, on: true });
  return Object.assign(env, { calls: f.calls });
}
const sale = (rev, card) => ['s', rev, card, 10 + rev, T, 'exact', 'A' + rev, 0, null];
const many = n => Array.from({ length: n }, (_, i) => sale(i + 1, 'C' + (i % 7)));
```

```js
test('première réception sur plusieurs pages, puis passage vide', async () => {
  const env = await feedLoad(many(12001));
  const { t, calls } = env;
  await t.poolFeed(true);
  assert.deepEqual(calls, ['/v1/feed?since=0&limit=5000', '/v1/feed?since=5000&limit=5000', '/v1/feed?since=10000&limit=5000']);
  assert.equal(t.db.pool.feed.rev, 12001);
  assert.equal(t.db.pool.feed.got, 12001);
  assert.equal(t.db.pool.feed.url, POOL, 'adresse normalisée, sans / final');
  assert.ok(t.db.pool.feed.at > 0);
  await t.poolFeed(true);
  assert.equal(calls.at(-1), '/v1/feed?since=12001&limit=5000');
});

test('une page en échec : la position reste à la dernière page fusionnée, puis reprend sans trou', async () => {
  let broken = true;
  const env = await feedLoad(many(12001), { fail: since => broken && since === 5000 });
  await env.t.poolFeed(true);
  assert.equal(env.t.db.pool.feed.rev, 5000);
  assert.ok(env.t.db.pool.err);
  broken = false;
  await env.t.poolFeed(true);
  assert.equal(env.t.db.pool.feed.rev, 12001);
});

test('corps inattendu : échec, position inchangée', async () => {
  const env = await feedLoad(many(10), { body: { hello: 1 } });
  await env.t.poolFeed(true);
  assert.equal(env.t.db.pool.feed.rev, 0);
  assert.ok(env.t.db.pool.err);
  assert.ok(env.t.db.pool.retryAt > Date.now());
});

test('retour à zéro : autre identifiant de pool, position au-delà de max, autre adresse', async () => {
  const state = { pool: 'p1' };
  const env = await feedLoad(many(10), state);
  const { t, calls } = env;
  await t.poolFeed(true);
  t.db.pool.feed.rev = 50; // base restaurée plus ancienne
  await t.poolFeed(true);
  assert.equal(t.db.pool.feed.rev, 10);
  assert.ok(calls.includes('/v1/feed?since=50&limit=5000') && calls.at(-1) === '/v1/feed?since=0&limit=5000');
  state.pool = 'p2';
  await t.poolFeed(true);
  assert.equal(t.db.pool.feed.pool, 'p2');
  assert.equal(calls.at(-1), '/v1/feed?since=0&limit=5000');
  t.db.pool.url = POOL; // même adresse sans / : pas de retour à zéro
  await t.poolFeed(true);
  assert.equal(calls.at(-1), '/v1/feed?since=10&limit=5000');
});

test('pool en 1.3.0 (404) : fil noté absent, ancienne méthode, nouvel essai au bout de 6 h', async () => {
  const env = await feedLoad([], { status: 404 });
  await env.t.poolFeed(true);
  assert.equal(env.t.feedOn(), false);
  assert.ok(env.t.db.pool.feed.off > 0);
  assert.equal(env.t.db.pool.err, '', 'un 404 du fil n’est pas une erreur du pool');
  env.t.db.pool.feed.off = Date.now() - 6 * 36e5 - 1;
  assert.equal(env.t.feedOn(), true);
  env.t.db.pool.feed.off = Date.now();
  env.t.db.pool.url = 'https://autre-pool.test';
  assert.equal(env.t.feedOn(), true, 'le 404 vaut pour une adresse');
});

test('mode secours : pas de fil ; une base neuve a sa position à zéro', () => {
  const { t } = load();
  assert.deepEqual(plain(t.db.pool.feed), { url: '', pool: '', rev: 0, at: 0, off: 0, got: 0 });
  Object.assign(t.db.pool, { url: POOL, key: KEY, on: true });
  assert.equal(t.feedOn(), false);
});

test('deux appels simultanés : une seule série de requêtes ; sans force, pas deux passages en moins d’une minute', async () => {
  const env = await feedLoad(many(10));
  await Promise.all([env.t.poolFeed(true), env.t.poolFeed(true)]);
  assert.equal(env.calls.length, 1);
  await env.t.poolFeed();
  assert.equal(env.calls.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run : `node --test test/pool-feed.test.js`
Expected : FAIL, `t.poolFeed is not a function`.

- [ ] **Step 3: Implement `feedOn()` and `poolFeed(force)`**
  - **Normaliser l'adresse** (`db.pool.url.replace(/\/+$/, '')`). Si elle diffère de `feed.url` : `feed = { url, pool: '', rev: 0, at: 0, off: 0, got: 0 }`.
  - **Boucle de pages :** `poolFetch('/v1/feed?since=' + rev + '&limit=' + POOL_FEED_PAGE)`.
  - **Corps valide :** `pool` est une chaîne non vide, `max`/`next` des entiers ≥ 0, `sales`/`pro`/`unsold` des tableaux. Sinon, lever une erreur (`pool : réponse inattendue`).
  - **Retour à zéro**, sans fusionner la page reçue : `feed.pool` est non vide et différent de `j.pool`, ou `feed.rev > j.max`. On remet `rev = 0, got = 0`, on note `j.pool`, et on redemande depuis 0.
  - **Sinon, à chaque page :**
    1. `applyFeedPage(j)` ;
    2. `feed.rev = j.next` ;
    3. `feed.got += j.sales.length` ;
    4. `saveDb()` ;
    5. mettre à jour `ui.el.poolInfo` s'il existe ;
    6. continuer tant que `j.more`, avec un garde-fou de 1 000 pages.
  - **Succès :** `feed.at = Date.now()`, `feed.off = 0`, `poolOk()`, `db.pool.recv += apporté`, et `resetPrices()` si l'apport n'est pas nul.
  - **Erreur 404 :** `feed.off = Date.now()`, sans `poolFailed`.
  - **Autre erreur :** `poolFailed(e, now)`.
  - **Toujours :** relâcher le verrou et `saveDb()`.

- [ ] **Step 4: Run tests to verify they pass**

Run : `node --test test/*.test.js`
Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js test/harness.js test/pool-feed.test.js
git commit -m "Script : passage du fil du pool (pages, position, reprises, repli 1.3.0)"
```

### Task 6: Script — branchement, ligne d'état, version 1.28.0

**Files:**
- Modify: `wikimasters-stats.user.js`
  - `poolTick` (~l. 1007), `poolPullMine` (~l. 1161), `poolWant` (~l. 1175), `poolPrefetch` (~l. 1205) ;
  - `poolLine` (~l. 2819) ;
  - le texte de la case « Partager et recevoir les prix » (~l. 3193) ;
  - `@version` (l. 4) et le repli de `VERSION` (l. 50).
- Modify: `test/harness.js` (ajouter `'poolLine'` à `EXPOSE`)
- Test: `test/pool-feed.test.js`

**Interfaces:**
- Consumes : `feedOn`, `poolFeed` (tâche 5).
- Produces :
  - **`poolTick(now)`** :
    - rien si le pool est éteint ou si `now < retryAt` ;
    - sinon, l'envoi si la file n'est pas vide (comme aujourd'hui) ;
    - et un passage `poolFeed()` si `feedOn()` et que `now - feed.at >= POOL_FEED_EVERY` ou `feed.at > now`. Après un passage qui apporte quelque chose : `refresh()`.

    Elle renvoie une promesse résolue quand les deux sont finis.
  - **`poolPullMine(force)`** :
    1. si `feedOn()`, `await poolFeed(force)` d'abord ;
    2. puis la porte des 6 h comme aujourd'hui ;
    3. la demande des cartes (`poolPull`) seulement si `!feedOn()` ;
    4. les profils toujours.
  - **`poolWant` et `poolPrefetch`** ne font rien quand `feedOn()`.
  - **`poolLine()`** ajoute une partie, juste après l'éventuelle erreur :
    - pendant un passage avec `feed.at === 0` : `réception de tout le pool : ` + `fmt(feed.got)` + ` ventes reçues` ;
    - sinon, si `feedOn()` et `feed.at` : `à jour ` + `ago(feed.at)` ;
    - sinon, si `feed.off` et que le pool est activé : `ancienne méthode (pool en 1.3.0)`.

- [ ] **Step 1: Write the failing tests** in `test/pool-feed.test.js` :

```js
test('poolTick lance un passage toutes les 15 min, et aussi quand la date du dernier est dans le futur', async () => {
  const env = await feedLoad(many(3));
  const { t, calls } = env;
  await t.poolTick(Date.now());
  assert.equal(calls.length, 1);
  await t.poolTick(Date.now() + 5 * 6e4);
  assert.equal(calls.length, 1, 'moins de 15 min : rien');
  t.db.pool.feed.at = Date.now() + 36e5; // horloge reculée
  await t.poolTick(Date.now());
  assert.equal(calls.length, 2);
});

test('fil actif : poolPullMine passe par le fil, poolWant et poolPrefetch se taisent', async () => {
  const env = await feedLoad(many(3));
  const { t, calls } = env;
  await t.poolPullMine(true);
  assert.ok(calls.some(c => c.startsWith('/v1/feed')));
  assert.ok(!calls.some(c => c === '/v1/pull'));
  const before = calls.length;
  t.poolWant('C9');
  await t.poolPrefetch(['C9']);
  await new Promise(r => setImmediate(r)); // fast : le regroupement de 2 s de poolWant passe tout de suite
  assert.equal(calls.length, before);
});

test('pool en 1.3.0 : poolPullMine retombe sur /v1/pull dans le même appel', async () => {
  const env = await feedLoad([], { status: 404 });
  env.t.db.wish = { C1: ['Carte', 'SR'] };
  await env.t.poolPullMine(true);
  assert.ok(env.calls.includes('/v1/pull'));
});

test('ligne d’état : à jour, puis ancienne méthode', async () => {
  const env = await feedLoad(many(3));
  await env.t.poolFeed(true);
  assert.match(env.t.poolLine(), /à jour à l’instant/);
  env.t.db.pool.feed.off = Date.now();
  env.t.db.pool.feed.at = 0;
  assert.match(env.t.poolLine(), /ancienne méthode \(pool en 1\.3\.0\)/);
});
```
- [ ] **Step 2: Run tests to verify they fail**

Run : `node --test test/pool-feed.test.js`
Expected : FAIL. `poolTick` ne passe pas par le fil, et `poolPullMine` appelle `/v1/pull`.

- [ ] **Step 3: Implement** the Interfaces above.
  - Texte de la case « Partager et recevoir les prix » : `… et reçoit ceux du groupe, toutes cartes confondues (seulement ta collection, tes souhaits et les cartes affichées quand le pool est encore en 1.3.0).`
  - `@version 1.28.0` et `VERSION … || '1.28.0'`.

- [ ] **Step 4: Run the whole suite**

Run : `node --test test/*.test.js`
Expected : PASS, tous les tests, anciens et nouveaux.

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js test/harness.js test/pool-feed.test.js
git commit -m "v1.28.0 : réception de tout le pool par le fil, toutes les 15 min"
```
