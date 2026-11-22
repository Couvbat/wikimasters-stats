# Historique par semaine et relevé pour tous — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** script 1.30.0 — le relevé des ventes marche pour tout compte reconnu, et l'historique des prix par semaine du site est enregistré quand le site le charge puis sert aux repères, à la courbe et à la bulle.

**Architecture:** tout est dans `wikimasters-stats.user.js`. `canFetchPrices()` remplace les tests Pro des relevés ; `ingestHistory` range les semaines dans `db.hist` (interception de l'appel du site, et bouton de la fiche) ; `cardCues` et `cardChart` reçoivent les semaines de la rareté affichée en dernier paramètre.

**Tech Stack:** userscript Tampermonkey (`@grant none`), tests `node --test` avec `test/harness.js`.

**Spec:** `docs/superpowers/specs/2026-11-22-historique-semaine-design.md`

**Branche :** `claude/historique-semaine`, partie de `claude/ventes-par-rarete` (1.29.1, PR #18). Avant la tâche 1 : `git checkout -b claude/historique-semaine claude/ventes-par-rarete`.

## Global Constraints

- Script seul : le serveur du pool ne change pas. Version **1.30.0** (`// @version` et repli de `VERSION`).
- Aucune requête au site sans clic : seul le bouton de la fiche demande `/price-history`. Les relevés automatiques n'en demandent jamais.
- La valeur, la fiabilité, les bonnes affaires et l'enchère max ne changent pas : l'historique (des moyennes) ne sert qu'à la fiche et à la bulle, et seulement en repli pour le prix du moment et le sens.
- `db.hist` est commun à tous les comptes (pas dans `PERSONAL`), absent de la sauvegarde et du fichier ami. Plafond : 3 000 cartes en IndexedDB, 200 en mode secours ; `trimHistory()` le vide.
- Une ligne de semaine : `[début 'AAAA-MM-JJ', moyenne, min, max, ventes]`, triées de la plus ancienne à la plus récente. Début d'une semaine en ms : `Date.parse(début + 'T00:00:00Z')`. Semaine complète : début + 7 j ≤ maintenant ; semaine en cours : début ≤ maintenant < début + 7 j.
- Plus aucun texte visible ne réserve un relevé aux comptes Pro (« (Pro) », « Compte Pro. », « compte Pro uniquement », « réservés aux comptes Pro »). Les commentaires sur la sorte « pro » des ventes du pool restent.
- Textes en français, apostrophe `’`, signe moins `−` devant un pourcentage négatif, comme en 1.29.

## Review Focus

1. **Réponse `/price-history` mal formée** (pas de `by_rarity`, `weekly` qui n'est pas un tableau, champs texte) : rien n'est enregistré, aucune erreur. Test en tâche 2.
2. **`computed_at` absent ou illisible** : la date de l'historique est maintenant. Test en tâche 2.
3. **Semaine en cours qui commence aujourd'hui, avec 0 à 2 ventes** : elle n'entre ni dans le repli du prix du moment (3 ventes au moins) ni dans le sens (3 ventes au moins pour la semaine en cours). Test en tâche 3.
4. **Historique d'une autre rareté seulement** (fiche en SR, historique C) : aucun repli, aucune semaine sur la courbe. Test en tâche 3.
5. **Compte pas encore reconnu** (`db.userId` vide) : aucun relevé, message « Compte pas encore reconnu ». Test en tâche 1.

---

### Task 1: Le relevé pour tous les comptes reconnus

**Files:**
- Modify: `wikimasters-stats.user.js` (tous les `proState()` qui bloquent un relevé ou en parlent : `showPrices`, `fillPrices`, `routinePass`/mise à jour automatique, `autoLine`, `fillTradePrices`, `fetchPricesFor`, `onPull`, `queueBidPrices`, `syncButtons`, bouton des échanges, tuile et message de Collection, bouton de la fiche), `README.md`
- Modify: `test/mise-a-jour-auto.test.js`, `test/releve-ventes.test.js`
- Add to git: la conception et ce plan

**Interfaces:**
- Produces: `canFetchPrices() -> boolean` (`!!db.userId`), à côté de `proState()`, qui reste et ne bloque plus rien.

- [ ] **Step 1: Adapter les tests existants et écrire les nouveaux**

Dans `test/mise-a-jour-auto.test.js` :
- remplacer `passage : compte non Pro, aucune requête /sales` par
  ```js
  test('passage : compte non Pro, les prix sont relevés aussi', async () => {
    const env = siteEnv();
    env.t.db.pro = { U1: false };
    env.t.db.cards = manyCards(5);
    await env.t.autoRun();
    assert.equal(env.sales().length, 5);
  });
  test('passage : compte pas encore reconnu, aucune requête /sales', async () => {
    const env = siteEnv();
    env.t.db.userId = '';
    env.t.db.cards = manyCards(5);
    await env.t.autoRun();
    assert.equal(env.sales().length, 0);
  });
  ```
- remplacer `bouton : compte non Pro, aucune requête /sales` par `bouton : compte non Pro, les prix sont relevés aussi` (même corps avec `updateAll()`, 5 relevés attendus) ;
- dans le test de `autoLine`, remplacer `t.db.pro = { U1: false };` par `t.db.userId = '';` (la fin « Encore … cartes à relire » disparaît sans compte reconnu).

Dans `test/releve-ventes.test.js` :
```js
test('compte non Pro : boosters et enchères relèvent aussi leurs prix', async () => {
  const env = salesEnv();
  env.t.db.pro = { U1: false };
  env.t.db.ov.bidAuto = true;
  env.t.onPull([{ card: { id: 'B1', wikipedia_title: 'X', rarity: 'SR' } }], 'standard');
  await settle();
  env.t.queueBidPrices([{ id: 'A1', card_id: 'E1', snapshot_rarity: 'C' }]);
  await settle();
  assert.deepEqual(env.sales(), ['B1/sales?rarity=SR', 'E1/sales?rarity=C']);
});

test('compte pas encore reconnu : aucun relevé, et le message le dit', async () => {
  const env = salesEnv();
  env.t.db.userId = '';
  env.t.ui.el.wishStatus = { textContent: '' };
  await env.t.fetchPricesFor([['C1', 'SR']], 'wishStatus', 'carte', 'cartes');
  assert.deepEqual(env.sales(), []);
  assert.match(env.t.ui.el.wishStatus.textContent, /^Compte pas encore reconnu/);
});
```
Ajouter `'fetchPricesFor'` à `EXPOSE`.

- [ ] **Step 2: Lancer, voir échouer**

Run: `node --test test/mise-a-jour-auto.test.js test/releve-ventes.test.js`
Expected: FAIL sur les tests « compte non Pro » (0 relevé au lieu de 5) et « pas encore reconnu » (ancien message « réservés aux comptes Pro »).

- [ ] **Step 3: Écrire `canFetchPrices` et l'utiliser partout où un relevé testait `proState() === true`**

- `onPull` : le panneau du dernier booster s'ouvre dès que `db.autoPull !== false` ; les prix ne partent que si `canFetchPrices()` ; sinon `pull.note = 'Compte pas encore reconnu : recharge la page (F5) pour activer les prix.'`.
- `fetchPricesFor` : sans compte reconnu, `setStatus('Compte pas encore reconnu : recharge la page (F5) pour relever les prix.', where)`.
- Boutons : « Relever les prix (Pro) » devient « Relever les prix » ; les bulles perdent « Compte Pro. ». Trouver tous les textes avec `grep -n "Compte Pro\|comptes Pro\|(Pro)\|compte Pro" wikimasters-stats.user.js README.md`.
- README : « (compte Pro uniquement) » disparaît ; la section « Compte non Pro » dit que depuis la mise à jour du site de novembre 2026 tout compte relève les prix comme un compte Pro, et garde ce qu'elle dit des prix observés et de tes ventes.

- [ ] **Step 4: Lancer la tâche et toute la suite**

Run: `node --test test/mise-a-jour-auto.test.js test/releve-ventes.test.js` puis `node --test test/*.test.js`
Expected: PASS partout.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-11-22-historique-semaine-design.md docs/superpowers/plans/2026-11-22-historique-semaine.md wikimasters-stats.user.js README.md test/harness.js test/mise-a-jour-auto.test.js test/releve-ventes.test.js
git commit -m "Relevé des prix pour tout compte reconnu, Pro ou non (le site donne les ventes à tous)"
```

---

### Task 2: Enregistrer l'historique par semaine

**Files:**
- Modify: `wikimasters-stats.user.js` : `defaults` (`hist: {}`), `cleanDb` (liste des objets), `trimHistory`, crochet `window.fetch` (branche GET du site), nouvelle `ingestHistory` près de `ingestSales`, bouton de la fiche
- Create: `test/historique-semaine.test.js`
- Modify: `test/harness.js`

**Interfaces:**
- Consumes: `canFetchPrices()` (tâche 1), `fetchPricesFor`, `getJSON`, `pace`, `startJob`/`endJob`, `store.mode`.
- Produces:
  - `ingestHistory(cardId, json) -> number` : le nombre de raretés enregistrées (0 si rien). Lit `json.by_rarity[rareté].weekly` pour chaque rareté valide ; garde les semaines lisibles (`/^\d{4}-\d{2}-\d{2}$/` sur `start`, `avg > 0`, `count` entier ≥ 0 ; `min`/`max` numériques, sinon `avg`) ; date `at` = `Date.parse(json.computed_at)` si lisible, sinon `Date.now()`. Une réponse dont `at` est plus ancien que celui déjà gardé est ignorée ; sinon chaque rareté reçue remplace la sienne et `at` est mis à jour. Au-delà du plafond (`store.mode === 'idb'` ? 3000 : 200), retire les cartes au plus petit `at`. Appelle `saveDb()` quand quelque chose change.
  - `histWeeks(cardId, rarity) -> Array|null` : `db.hist[cardId].w[rarity]` si la rareté est valide et a des semaines, sinon `null`.
  - Crochet : `GET /api/marketplace/cards/<id>/price-history` du site → `ingestHistory`, puis `refresh()` si quelque chose a été enregistré.
  - Fiche : `ui.el.cardPro` devient `ui.el.cardFetch`, bouton « Relever les ventes » (`data-tip` : « Relit les 5 dernières ventes de cette carte à cette rareté, puis son historique des prix par semaine. Deux requêtes. »), présent quand `canFetchPrices()`. Son action `cardFetchNow()` : rien si `job.running` ; `await fetchPricesFor([[id, rarity]], 'cardStatus', 'carte', 'cartes')` ; puis, entre `startJob('Historique des prix…', 'cardStatus')` et `endJob`, `await pace()`, `getJSON('/api/marketplace/cards/<id>/price-history')` et `ingestHistory` (message de fin « Ventes et historique relevés. », ou « Historique indisponible (message) » sur erreur) ; enfin `renderCard()` si la même carte est ouverte. `syncCardButtons` grise `cardFetch` pendant un traitement.

- [ ] **Step 1: Écrire les tests**

```js
// Historique des prix par semaine (1.30.0). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, reply, plain } = require('./harness');
const DAY = 864e5, NOW = Date.now();
const settle = async () => { for (let i = 0; i < 100; i++) await new Promise(r => setImmediate(r)); };
const PH = (at, weeks = { SR: [{ start: '2026-11-09', avg: 120, min: 80, max: 200, count: 6 }, { start: '2026-11-16', avg: 110, min: 90, max: 150, count: 4 }] }) =>
  ({ computed_at: at, by_rarity: Object.fromEntries(Object.entries(weeks).map(([r, w]) => [r, { weekly: w, monthly: [] }])) });

test('historique : enregistré par rareté, semaines triées, une semaine illisible ignorée', () => {
  const { t } = load();
  const n = t.ingestHistory('C1', PH('2026-11-22T13:40:00Z', { SR: [{ start: '2026-11-16', avg: 110, min: 90, max: 150, count: 4 },
    { start: 'hier', avg: 5, min: 5, max: 5, count: 1 }, { start: '2026-11-09', avg: 120, min: 80, max: 200, count: 6 }], ZZ: [{ start: '2026-11-09', avg: 1, min: 1, max: 1, count: 1 }] }));
  assert.equal(n, 1);
  assert.deepEqual(plain(t.db.hist.C1.w), { SR: [['2026-11-09', 120, 80, 200, 6], ['2026-11-16', 110, 90, 150, 4]] });
  assert.equal(t.db.hist.C1.at, Date.parse('2026-11-22T13:40:00Z'));
});

test('historique : une réponse plus récente remplace, une plus ancienne est ignorée ; computed_at illisible = maintenant', () => {
  const { t } = load();
  t.ingestHistory('C1', PH('2026-11-22T13:40:00Z'));
  t.ingestHistory('C1', PH('2026-11-20T00:00:00Z', { SR: [{ start: '2026-11-02', avg: 999, min: 999, max: 999, count: 1 }] }));
  assert.equal(t.db.hist.C1.w.SR[0][1], 120, 'plus ancienne : ignorée');
  t.ingestHistory('C1', PH('n/a', { SR: [{ start: '2026-11-16', avg: 140, min: 140, max: 140, count: 2 }] }));
  assert.equal(t.db.hist.C1.w.SR[0][1], 140);
  assert.ok(Math.abs(t.db.hist.C1.at - Date.now()) < 5000);
});

test('historique : réponse mal formée, rien n’est enregistré', () => {
  const { t } = load();
  for (const j of [null, {}, { by_rarity: 3 }, { by_rarity: { SR: { weekly: 'x' } } }, { by_rarity: { SR: { weekly: [{ start: '2026-11-16', avg: 'cent', count: 2 }] } } }]) {
    assert.equal(t.ingestHistory('C1', j), 0);
  }
  assert.equal(t.db.hist.C1, undefined);
});

test('historique : 200 cartes au plus en mode secours, les plus anciennes partent ; trimHistory le vide', () => {
  const { t } = load();
  for (let i = 0; i < 205; i++) t.ingestHistory('K' + i, PH(new Date(Date.parse('2026-11-01T00:00:00Z') + i * 6e4).toISOString()));
  assert.equal(Object.keys(t.db.hist).length, 200);
  assert.equal(t.db.hist.K0, undefined);
  assert.ok(t.db.hist.K204);
  t.trimHistory();
  assert.deepEqual(plain(t.db.hist), {});
});

test('historique : la Vue du marché du site, en se chargeant, l’enregistre', async () => {
  const env = load({ fast: true, fetch: async () => reply(PH('2026-11-22T13:40:00Z')) });
  await env.ready;
  await env.window.fetch('https://www.wiki-masters.com/api/marketplace/cards/C1/price-history');
  await settle();
  assert.equal(env.t.db.hist.C1.w.SR.length, 2);
});

test('fiche : « Relever les ventes » demande les ventes puis l’historique', async () => {
  const urls = [];
  const { t } = load({ fast: true, fetch: async url => { urls.push(url); return reply(/price-history/.test(url) ? PH('2026-11-22T13:40:00Z') : { recent: [] }); } });
  t.db.userId = 'U1';
  for (const k of ['cardHead', 'cardBody']) t.ui.el[k] = { replaceChildren() {} };
  t.ui.el.cardStatus = { textContent: '' };
  t.openCard('C1', { rarity: 'SR', title: 'X' });
  await t.cardFetchNow();
  assert.equal(urls[urls.length - 1], '/api/marketplace/cards/C1/price-history');
  assert.ok(urls.includes('/api/marketplace/cards/C1/sales?rarity=SR'));
  assert.ok(urls.indexOf('/api/marketplace/cards/C1/sales?rarity=SR') < urls.indexOf('/api/marketplace/cards/C1/price-history'));
  assert.equal(t.db.hist.C1.w.SR.length, 2);
});
```
Ajouter `'ingestHistory', 'cardFetchNow'` à `EXPOSE`.

- [ ] **Step 2: Lancer, voir échouer**

Run: `node --test test/historique-semaine.test.js`
Expected: FAIL, `t.ingestHistory is not a function`.

- [ ] **Step 3: Écrire `ingestHistory`, `histWeeks`, le crochet, `db.hist`, `trimHistory`, et le bouton « Relever les ventes »**

- [ ] **Step 4: Lancer la tâche et toute la suite**

Run: `node --test test/historique-semaine.test.js` puis `node --test test/*.test.js`
Expected: PASS partout (le test de la fiche « actions grisées » de la 1.29.0 reste vert : il ne lit que `cardSearch`).

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js test/harness.js test/historique-semaine.test.js
git commit -m "Historique des prix par semaine : enregistré quand le site le charge, et par le bouton « Relever les ventes » de la fiche"
```

---

### Task 3: Les repères avec l'historique

**Files:**
- Modify: `wikimasters-stats.user.js` : `cardCues`, `cueLines`, `cuesOf`, `renderCard`
- Modify: `test/historique-semaine.test.js`

**Interfaces:**
- Consumes: `histWeeks` (tâche 2).
- Produces:
  - `cardCues(sales, now, asks, weeks) -> Cues` (toujours pure ; `weeks` peut manquer ou être `null`). En plus de la 1.29 : `moment.src` et `slope.src` valent `'sales'` ou `'hist'` ; `pace.src` vaut `'sales'` ou `'hist'`, et `pace.n4` (ventes des semaines complètes retenues) quand `src === 'hist'`.
  - Règles (voir la conception) :
    - **pace** : s'il y a au moins une semaine complète, `n4` = ventes des 4 dernières semaines complètes (ou de toutes s'il y en a moins), `perWeek = n4 / nombre de ces semaines`.
    - **moment**, seulement si le calcul sur les ventes est `few` : semaine en cours (3 ventes au moins) contre la moyenne pondérée par les ventes des 4 dernières semaines complètes (5 ventes au moins en tout) ; `med7` = moyenne de la semaine en cours, `n7` = ses ventes, `medBase` = moyenne pondérée, `nBase` = leurs ventes ; mêmes seuils.
    - **slope**, seulement si le calcul sur les ventes est `few` : Theil-Sen sur `ln(moyenne)` des 8 dernières semaines qui ont des ventes (la semaine en cours seulement avec 3 ventes au moins), placées à début + 3,5 j ; 4 semaines au moins ; mêmes seuils.
  - Textes de `cueLines` quand `src === 'hist'` :
    - pace : `se vend environ R fois par semaine sur le marché` (R = `Math.round(perWeek)`, si `perWeek >= 1`), sinon `se vend environ N fois par mois sur le marché` (N = `n4`) si `n4 > 0`, sinon `aucune vente en 4 semaines sur le marché` ; puis ` · dernière vente …` comme en 1.29.
    - moment : le libellé de la 1.29 (`plus cher que d’habitude (+P %)`…) puis ` · cette semaine : X ₩ (N ventes), 4 semaines d’avant : Y ₩ (M ventes), moyennes du site`.
    - slope : le texte de la 1.29 puis ` · moyennes du site`.
  - `cuesOf(cardId, rarity)` passe `histWeeks(cardId, rarity)` ; rend `null` seulement sans vente **et** sans semaines ; signature du cache = celle de la 1.29 plus `db.hist[cardId] ? db.hist[cardId].at : 0`.
  - `renderCard` passe `histWeeks(id, rarity)` à `cardCues`. La branche « Aucune vente connue à cette rareté » ne s'applique plus que sans vente **et** sans semaines ; avec des semaines mais sans vente, la fiche montre les repères, et la note `Aucune vente connue à cette rareté.` à la place de la liste.

- [ ] **Step 1: Écrire les tests** (ajoutés à `test/historique-semaine.test.js`)

```js
const sale = (d, p) => ({ p, t: new Date(NOW - d * DAY).toISOString(), r: 'SR' });
// Une semaine commencée il y a `d` jours : 2 → semaine en cours ; 9, 16, 23, 30… → semaines complètes.
const wk = (d, avg, count, min = avg, max = avg) => [new Date(NOW - d * DAY).toISOString().slice(0, 10), avg, min, max, count];

test('repères : le rythme vient de l’historique du site', () => {
  const { t } = load();
  const pace = weeks => t.cueLines(t.cardCues([sale(1, 100)], NOW, null, weeks)).find(l => l.k === 'pace').text.replace(/[  ]/g, ' ');
  assert.match(pace([wk(30, 100, 8), wk(23, 100, 6), wk(16, 100, 10), wk(9, 100, 4)]), /^se vend environ 7 fois par semaine sur le marché · dernière vente/);
  assert.match(pace([wk(30, 100, 1), wk(23, 100, 0), wk(16, 100, 1), wk(9, 100, 0)]), /^se vend environ 2 fois par mois sur le marché/);
  assert.match(pace([wk(16, 100, 0), wk(9, 100, 0)]), /^aucune vente en 4 semaines sur le marché/);
});

test('repères : prix du moment tiré des moyennes du site quand les ventes ne suffisent pas', () => {
  const { t } = load();
  const weeks = [wk(30, 100, 2), wk(23, 100, 2), wk(16, 100, 2), wk(9, 100, 2), wk(2, 130, 4)];
  const c = t.cardCues([sale(1, 130)], NOW, null, weeks);
  assert.equal(c.moment.state, 'high');
  assert.equal(c.moment.pct, 30);
  assert.equal(c.moment.src, 'hist');
  const text = t.cueLines(c)[0].text.replace(/[  ]/g, ' ');
  assert.match(text, /· cette semaine : 130 ₩ \(4 ventes\), 4 semaines d’avant : 100 ₩ \(8 ventes\), moyennes du site$/);
  assert.equal(t.cardCues([], NOW, null, [...weeks.slice(0, 4), wk(2, 130, 2)]).moment.state, 'few', '2 ventes cette semaine');
  assert.equal(t.cardCues([], NOW, null, [wk(16, 100, 2), wk(9, 100, 2), wk(2, 130, 4)]).moment.state, 'few', '4 ventes avant');
});

test('repères : les ventes passent avant l’historique quand elles suffisent', () => {
  const { t } = load();
  const sales = [sale(1, 100), sale(2, 100), sale(3, 100), ...[10, 12, 14, 16, 18].map(d => sale(d, 100))];
  const c = t.cardCues(sales, NOW, null, [wk(30, 50, 9), wk(23, 50, 9), wk(16, 50, 9), wk(9, 50, 9), wk(2, 200, 9)]);
  assert.equal(c.moment.src, 'sales');
  assert.equal(c.moment.state, 'usual');
});

test('repères : sens tiré des moyennes du site, 4 semaines au moins, semaine en cours maigre écartée', () => {
  const { t } = load();
  const rising = [58, 51, 44, 37, 30, 23, 16, 9].map((d, i) => wk(d, Math.round(100 * Math.pow(1.1, i)), 5));
  const c = t.cardCues([], NOW, null, rising.concat([wk(2, 10, 1)]));
  assert.equal(c.slope.src, 'hist');
  assert.equal(c.slope.state, 'up');
  assert.match(t.cueLines(c)[1].text, / · moyennes du site$/);
  assert.equal(t.cardCues([], NOW, null, rising.slice(-3)).slope.state, 'few');
});

test('fiche : un historique d’une autre rareté ne sert à rien', () => {
  const { t } = load();
  t.ingestHistory('C1', PH(new Date().toISOString(), { C: [{ start: wk(9, 1, 1)[0], avg: 100, min: 100, max: 100, count: 8 }] }));
  assert.equal(t.histWeeks('C1', 'SR'), null);
  assert.ok(t.histWeeks('C1', 'C'));
});

test('bulle : un historique reçu change la ligne « Repères »', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 130)] };
  t.db.cards.X1 = { cardId: 'C1', title: 'X', rarity: 'SR', count: 1 };
  assert.ok(!t.badgeFor('C1', null, {}).lines.some(l => l.startsWith('Repères')));
  t.ingestHistory('C1', PH(new Date().toISOString(), { SR: [30, 23, 16, 9].map(d => ({ start: wk(d, 1, 1)[0], avg: 100, min: 100, max: 100, count: 2 }))
    .concat([{ start: wk(2, 1, 1)[0], avg: 130, min: 130, max: 130, count: 4 }]) }));
  assert.ok(t.badgeFor('C1', null, {}).lines.some(l => /^Repères : plus cher que d’habitude/.test(l)));
});
```
Ajouter `'histWeeks'` à `EXPOSE`.

- [ ] **Step 2: Lancer, voir échouer**

Run: `node --test test/historique-semaine.test.js`
Expected: FAIL sur les nouveaux tests (pas de `src`, pas de repli, `t.histWeeks` absent si la tâche 2 ne l'a pas exposé).

- [ ] **Step 3: Étendre `cardCues`, `cueLines`, `cuesOf` et `renderCard`**

- [ ] **Step 4: Lancer la tâche et toute la suite**

Run: `node --test test/historique-semaine.test.js` puis `node --test test/*.test.js`
Expected: PASS partout (les tests des repères de la 1.29 n'ont pas d'historique : ils ne changent pas).

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js test/harness.js test/historique-semaine.test.js
git commit -m "Repères : rythme du marché et repli du prix du moment et du sens sur l'historique du site"
```

---

### Task 4: La courbe avec les semaines, version 1.30.0

**Files:**
- Modify: `wikimasters-stats.user.js` : `cardChart`, `renderCard` (appel de la courbe, légende), `@version` et repli de `VERSION`
- Modify: `README.md` (section « Fiche d’une carte »), `test/historique-semaine.test.js`

**Interfaces:**
- Consumes: `histWeeks`, `moment.src` (tâche 3).
- Produces:
  - `cardChart(points, marks, period, now, lines, weeks)` : `weeks` peut manquer. Pour chaque semaine de la période : un `line` vertical gris (`#4b5563`, sans `stroke-dasharray`) de son min à son max, au milieu de la semaine (début + 3,5 j, ramené à `now` au plus) ; les moyennes reliées par un seul `polyline` (`#93c5fd`) quand il y a au moins 2 semaines. Pour « tout », l'axe des dates part aussi de la plus ancienne semaine. Bornes de l'axe des prix : ventes, marques et moyennes ; min et max coupés aux bornes. Le texte « aucune vente sur cette période » n'apparaît que sans vente, sans marque et sans semaine dans la période. Aucun nouveau `circle`, `path` ni trait en pointillés.
  - `renderCard` passe `histWeeks(id, rarity)` ; les médianes (`lines`) ne sont passées que si `cues.moment.src === 'sales'`, sinon `{ med7: null, medBase: null }` ; la légende ajoute `ligne grise : moyenne par semaine du site, barres : son minimum et son maximum` quand il y a des semaines. La courbe s'affiche aussi pour une carte qui n'a que des semaines.

- [ ] **Step 1: Écrire les tests**

```js
test('courbe : moyennes par semaine et barres min–max, sans casser les formes de la 1.29.0', () => {
  const { t } = load();
  const pts = [{ t: NOW - DAY, p: 120, k: 'pro' }, { t: NOW - 2 * DAY, p: 110, k: 'prov' }];
  const weeks = [wk(23, 100, 3, 60, 180), wk(16, 105, 4, 70, 200), wk(9, 115, 5, 80, 160)];
  const svg = t.cardChart(pts, [], '30', NOW, { med7: null, medBase: null }, weeks);
  const find = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const k of n.children || []) find(k, pred, out); } return out; };
  assert.equal(find(svg, n => n.tagName === 'polyline').length, 1);
  assert.equal(find(svg, n => n.tagName === 'line' && n.attrs.stroke === '#4b5563').length, 3);
  assert.equal(find(svg, n => n.tagName === 'circle').length, 2);
  assert.equal(find(svg, n => n.attrs && n.attrs['stroke-dasharray']).length, 0);
  const only = t.cardChart([], [], 'all', NOW, null, weeks);
  assert.ok(!find(only, n => n.tagName === 'text' && (n.children || []).join('').includes('aucune vente')).length, 'des semaines seules suffisent');
});

test('fiche : pas de médianes quand le prix du moment vient de l’historique', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 130), sale(20, 100)] };
  t.ingestHistory('C1', PH(new Date().toISOString(), { SR: [30, 23, 16, 9].map(d => ({ start: wk(d, 1, 1)[0], avg: 100, min: 100, max: 100, count: 2 }))
    .concat([{ start: wk(2, 1, 1)[0], avg: 130, min: 130, max: 130, count: 4 }]) }));
  const out = {};
  t.ui.el.cardHead = { replaceChildren() {} };
  t.ui.el.cardBody = { replaceChildren(...k) { out.body = k; } };
  t.ui.el.cardStatus = { textContent: '' };
  t.openCard('C1', { rarity: 'SR', title: 'X' });
  t.renderCard();
  const find = (n, pred, acc = []) => { if (Array.isArray(n)) { n.forEach(x => find(x, pred, acc)); return acc; } if (n && typeof n === 'object') { if (pred(n)) acc.push(n); for (const k of n.children || []) find(k, pred, acc); } return acc; };
  assert.equal(find(out.body, n => n.attrs && n.attrs['stroke-dasharray']).length, 0);
  assert.equal(find(out.body, n => n.tagName === 'polyline').length, 1);
});
```

- [ ] **Step 2: Lancer, voir échouer**

Run: `node --test test/historique-semaine.test.js`
Expected: FAIL (pas de `polyline` ni de barres).

- [ ] **Step 3: Étendre `cardChart` et son appel, passer en 1.30.0, compléter le README**

README, section « Fiche d’une carte » : l'historique par semaine (enregistré quand tu ouvres la Vue du marché du site, ou par « Relever les ventes »), le rythme du marché, le repli du prix du moment et du sens « d’après les moyennes du site », la ligne grise et les barres de la courbe.

- [ ] **Step 4: Lancer la tâche et toute la suite**

Run: `node --test test/historique-semaine.test.js` puis `node --test test/*.test.js`
Expected: PASS partout (les tests de courbe de la 1.29.0 comptent toujours 3 `circle`, 1 `path` et 1 trait en pointillés : ils n'ont pas de semaines).

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js README.md test/historique-semaine.test.js
git commit -m "v1.30.0 : courbe avec les moyennes par semaine du site ; historique et relevé pour tous"
```
