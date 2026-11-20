# Fiche par carte — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** une fiche par carte et par rareté, dans le panneau Stats, qui donne des repères sur « maintenant » (prix du moment, sens, rythme, concurrence, gain, annonce), avec une courbe et la liste des ventes ; ouverte depuis le panneau et depuis les pastilles du site ; script 1.29.0.

**Architecture:** tout est dans `wikimasters-stats.user.js`. Des fonctions pures calculent la source des ventes (partagée avec `priceOf`) et les repères ; une vue `view_card` du panneau, hors de la barre d'onglets, les affiche ; la pastille du site ouvre cette vue au clic et montre les repères en court dans sa bulle.

**Tech Stack:** userscript Tampermonkey (`@grant none`), DOM et SVG faits main (`h`, `s`), tests `node --test` avec le harnais `test/harness.js`.

**Spec:** `docs/superpowers/specs/2026-11-19-fiche-carte-design.md` (les choix marqués « au plan » y sont déjà reportés).

## Global Constraints

- Script seul : le serveur ne change pas. Version **1.29.0** : `// @version      1.29.0` et le repli de `VERSION` (`'1.29.0'`).
- Aucune bibliothèque : la courbe est un SVG fait par le script (`s(tag, attrs, ...kids)`).
- Aucun verdict : jamais « vends », « vendre maintenant », « achète » comme conseil dans la fiche ou la bulle. Des repères seulement.
- Aucune requête au site sans clic de Jules : seules les deux actions de la fiche en font, sur clic.
- Valeur, fiabilité, bonnes affaires et enchère max ne changent pas ailleurs : la réécriture de `priceOf` garde exactement son comportement (toute la suite existante reste verte).
- Les ventes de la fiche viennent de la même source que `priceOf`, à la même rareté, sans jamais mélanger les raretés.
- Calculs seulement à l'ouverture de la fiche ; la ligne de la bulle est gardée en cache.
- Seuils regroupés dans une constante `CUE` : `RECENT_DAYS: 7, RECENT_MIN: 3, BASE_DAYS: 30, BASE_MIN: 5, MOMENT_PCT: 15, SLOPE_DAYS: 30, SLOPE_MIN: 6, SLOPE_MAX: 300, SLOPE_PCT: 5, PACE_DAYS: 30`.
- Textes en français, apostrophe typographique `’` comme dans le reste du script, signe moins `−` (U+2212) devant un pourcentage négatif.
- Tests : nouveau fichier `test/fiche-carte.test.js` ; chaque fonction testée est ajoutée à la liste `EXPOSE` de `test/harness.js`. Lancer `node --test test/*.test.js`.

## Review Focus

1. **Dates de vente illisibles ou dans le futur** (horloge d'un membre décalée) : une date illisible est ignorée, une date future compte comme maintenant ; jamais « NaN », « undefined » ni « Infinity » dans la fiche. Test en tâche 2.
2. **Ventes toutes à la même date, ou au même prix** : pas de pente (« pas assez de ventes »), et un axe des prix qui ne s'écrase pas (bornes élargies d'un ₩). Tests en tâches 2 et 4.
3. **Carte inconnue partout** (ouverte depuis une pastille du marché : ni rareté, ni vente, ni nom connu) : la fiche s'affiche avec « Aucune vente connue », sans planter, et la recherche par nom est grisée. Tests en tâche 3.
4. **Nouvelles ventes reçues pendant que la bulle est en cache** (fil du pool, relevé Pro) : la ligne « Repères » change tout de suite. Test en tâche 5.
5. **Un autre traitement tourne pendant que la fiche est ouverte** : ses deux boutons sont grisés, puis se rallument à la fin du traitement (`syncButtons`). Test en tâche 3.

---

### Task 1: La source des ventes de la fiche

**Files:**
- Modify: `wikimasters-stats.user.js` (`priceOf` et son voisinage, vers les lignes 1582-1641)
- Modify: `test/harness.js` (liste `EXPOSE`)
- Create: `test/fiche-carte.test.js`
- Add to git: `docs/superpowers/specs/2026-11-19-fiche-carte-design.md`, `docs/superpowers/plans/2026-11-20-fiche-carte.md`

**Interfaces:**
- Consumes: `salesFor(list, rarity)`, `db.prices`, `db.mySales`, `db.obsSales`, `RARITIES`, `rarOk`.
- Produces:
  - `pickSource(cardId, want) -> { rec, src }` : `rec` = `db.prices[cardId]` ; `src` = `{ kind: 'pro'|'own'|'obs', sales, mixed }` ou `undefined`. C'est exactement le choix que fait `priceOf` aujourd'hui (la première source sans mélange, sinon la première qui a des ventes).
  - `cardSource(cardId, rarity) -> { kind: 'pro'|'own'|'obs'|null, sales: Sale[] }` : la source de `pickSource`, toutes ses ventes (les plus récentes d'abord, telles que rangées) ; `{ kind: null, sales: [] }` quand il n'y a rien ou que la source est mélangée. `rarity` vide : toutes les ventes de la source, comme `priceOf`.
  - `cardRarities(cardId) -> string[]` : les raretés qui ont au moins une vente dans l'une des trois sources, dans l'ordre de `RARITIES`.

- [ ] **Step 1: Écrire les tests qui échouent** (`test/fiche-carte.test.js`, en-tête commun aux tâches suivantes)

```js
// Tests de la fiche par carte (1.29.0). Lancer : node --test test/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const DAY = 864e5, NOW = Date.now();
const iso = d => new Date(NOW - d * DAY).toISOString();
const sale = (d, p, r = 'SR', more = {}) => Object.assign({ p, t: iso(d), r }, more);
const nb = s => String(s).replace(/[  ]/g, ' ');
const textOf = n => (n == null || n === false ? '' : Array.isArray(n) ? n.map(textOf).join(' ')
  : typeof n === 'object' ? (n.textContent || '') + ' ' + (n.children || []).map(textOf).join(' ') : String(n));
const find = (n, pred, out = []) => {
  if (Array.isArray(n)) { for (const k of n) find(k, pred, out); return out; }
  if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const k of n.children || []) find(k, pred, out); }
  return out;
};

test('source de la fiche : celle de priceOf, avec toutes ses ventes (l’historique Pro passe devant les prix observés)', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: Array.from({ length: 12 }, (_, i) => sale(i * 5, 100 + i)) };
  t.db.obsSales.C1 = [sale(1, 50, 'SR', { x: 1, i: 'A1' }), sale(2, 55, 'SR', { x: 1, i: 'A2' })];
  const src = t.cardSource('C1', 'SR');
  assert.equal(src.kind, 'pro');
  assert.equal(src.sales.length, 12);
  assert.equal(t.priceOf('C1', 'SR').nAll, 12, 'priceOf repose sur la même source');
});

test('source de la fiche : tes ventes sans historique Pro, sinon les prix observés', () => {
  const { t } = load();
  t.db.obsSales.C1 = [sale(1, 50, 'SR', { x: 1, i: 'A1' })];
  assert.equal(t.cardSource('C1', 'SR').kind, 'obs');
  t.db.mySales.C1 = [sale(3, 70)];
  assert.equal(t.cardSource('C1', 'SR').kind, 'own');
});

test('source de la fiche : aucune vente à la rareté voulue, pas de mélange ; les raretés qui ont des ventes', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 900, 'UR'), sale(2, 950, 'L')] };
  assert.deepEqual(plain(t.cardSource('C1', 'SR')), { kind: null, sales: [] });
  assert.equal(t.priceOf('C1', 'SR').mixed, true, 'priceOf, lui, se rabat sur les autres raretés');
  assert.deepEqual(plain(t.cardRarities('C1')), ['L', 'UR']);
});
```

Ajouter `'cardSource', 'cardRarities'` à `EXPOSE` dans `test/harness.js`.

- [ ] **Step 2: Lancer les tests, les voir échouer**

Run: `node --test test/fiche-carte.test.js`
Expected: FAIL, `t.cardSource is not a function`.

- [ ] **Step 3: Écrire `pickSource`, `cardSource`, `cardRarities`, et faire passer `priceOf` par `pickSource`**

`priceOf` remplace ses lignes `rec` / `sources` / `src` par `const { rec, src } = pickSource(cardId, want);` ; le reste de `priceOf` ne bouge pas. Commentaire de `cardSource` : la fiche ne mélange jamais les raretés, contrairement à `priceOf` qui se rabat sur d'autres raretés (fiabilité 0).

- [ ] **Step 4: Lancer les tests de la tâche et toute la suite**

Run: `node --test test/fiche-carte.test.js` puis `node --test test/*.test.js`
Expected: PASS partout (3 nouveaux tests ; aucun test existant ne change).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-11-19-fiche-carte-design.md docs/superpowers/plans/2026-11-20-fiche-carte.md wikimasters-stats.user.js test/harness.js test/fiche-carte.test.js
git commit -m "Fiche : source des ventes partagée avec priceOf, sans mélange de raretés"
```

---

### Task 2: Les repères

**Files:**
- Modify: `wikimasters-stats.user.js` (après `maxBid`, dans la partie « calculs »)
- Modify: `test/harness.js`, `test/fiche-carte.test.js`

**Interfaces:**
- Consumes: `median`, `DAY`, `rarOk`, `fmt`, `plural`, `ago`.
- Produces:
  - `CUE` (constante, valeurs dans Global Constraints).
  - `cardCues(sales, now, asks) -> Cues`, **pure** (aucune lecture de `db`). `sales` : `[{ p, t (texte ISO), x? }]` dans n'importe quel ordre ; une date illisible ou un prix ≤ 0 est ignoré, une date future compte comme `now`. `asks` : `null`, ou `{ list: [{ a, b, e, i, r }], rarity, seenAt }` (`list` = annonces en cours, toutes raretés ; la fonction garde celles de `rarity`, ou de rareté inconnue). Rend :
    ```
    { moment:  { state: 'high'|'low'|'usual'|'few', pct, med7, n7, medBase, nBase },
      slope:   { state: 'up'|'down'|'flat'|'few', pct, n },
      pace:    { n30, perWeek, lastT },        // lastT : date (ms) de la dernière vente, 0 sans vente
      compete: null | { n, min, seenAt } }     // null quand asks est null
    ```
    En `few`, `moment.pct`, `moment.med7`, `moment.medBase` et `slope.pct` valent `null` (les comptes `n7`, `nBase`, `n` restent) : la courbe de la tâche 4 ne dessine alors pas les médianes.
  - `cueLines(cues) -> [{ k: 'moment'|'slope'|'pace'|'compete', label, text }]`, dans cet ordre ; `compete` absent quand `cues.compete` est null. Libellés : `Prix du moment`, `Sens`, `Rythme`, `Concurrence`.
  - `cueShort(cues) -> string` : `'plus cher que d’habitude · en hausse'`, une seule partie si l'autre est `few`, `''` si les deux le sont.

Règles (tous les âges : `now - t`, en jours) :
- **moment** : `n7` ventes d'âge ≤ 7 ; `nBase` ventes d'âge > 7 et ≤ 37. `few` si `n7 < 3` ou `nBase < 5`. Sinon `pct = Math.round(100 * (med7 / medBase - 1))` ; `high` si `pct >= 15`, `low` si `pct <= -15`, sinon `usual`.
- **slope** : les ventes d'âge ≤ 30, les 300 plus récentes. Pente de Theil-Sen sur le logarithme du prix ; `few` s'il y a moins de 6 ventes ou aucune paire de dates différentes. `up` si `pct >= 5`, `down` si `pct <= -5`, sinon `flat`.
  ```js
  const slopes = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
    if (pts[j].t !== pts[i].t) slopes.push((Math.log(pts[j].p) - Math.log(pts[i].p)) / (pts[j].t - pts[i].t));
  const pct = Math.round(100 * (Math.exp(median(slopes) * 7 * DAY) - 1));
  ```
- **pace** : `n30` ventes d'âge ≤ 30 ; `perWeek = n30 * 7 / 30`.
- **compete** : `n` annonces gardées, `min` le plus petit prix.

Textes exacts de `cueLines` :
- moment : `plus cher que d’habitude (+P %)`, `moins cher que d’habitude (−P %)`, `dans son habitude`, suivis (hors `few`) de ` · 7 derniers jours : X ₩ (N ventes), 30 jours d’avant : Y ₩ (M ventes)` (X, Y arrondis, `fmt`, `plural`) ; `few` : `pas assez de ventes pour comparer`.
- slope : `en hausse (+P % par semaine)`, `en baisse (−P % par semaine)`, `stable` ; `few` : `pas assez de ventes sur 30 jours pour dire le sens`.
- pace : `perWeek >= 1` → `se vend environ R fois par semaine` (R = `Math.round(perWeek)`) ; `0 < perWeek < 1` → `se vend environ N fois par mois` (N = `n30`) ; `n30 = 0` → `aucune vente en 30 jours`. Puis ` · dernière vente ` + `ago(lastT)` quand `lastT`.
- compete : `n > 0` → `N en vente, la moins chère à X ₩` + (` · relevé ` + `ago(seenAt)` quand `seenAt`) ; `n = 0` et `seenAt` → `aucune annonce connue à cette rareté (relevé ` + `ago(seenAt)` + `)` ; sinon `annonces jamais cherchées`.

- [ ] **Step 1: Écrire les tests qui échouent** (ajoutés à `test/fiche-carte.test.js`)

```js
const base5 = p => [10, 12, 14, 16, 18].map(d => sale(d, p));
// Prix qui évolue de `weekly` par semaine : 1000 ₩ aujourd'hui, n ventes espacées de 3,5 jours à partir d'hier.
const trend = (weekly, n = 8) => Array.from({ length: n }, (_, i) => { const d = 1 + i * 3.5; return sale(d, Math.round(1000 * Math.pow(1 + weekly, -d / 7))); });

test('repère 1 : plus cher, moins cher, dans son habitude', () => {
  const { t } = load();
  const m = sales => t.cardCues(sales, NOW, null).moment;
  let c = m([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)]);
  assert.equal(c.state, 'high'); assert.equal(c.pct, 30);
  c = m([sale(1, 80), sale(2, 80), sale(3, 80), ...base5(100)]);
  assert.equal(c.state, 'low'); assert.equal(c.pct, -20);
  assert.equal(m([sale(1, 105), sale(2, 105), sale(3, 105), ...base5(100)]).state, 'usual');
  const line = nb(t.cueLines(t.cardCues([sale(1, 80), sale(2, 80), sale(3, 80), ...base5(100)], NOW, null))[0].text);
  assert.match(line, /^moins cher que d’habitude \(−20 %\) · 7 derniers jours : 80 ₩ \(3 ventes\), 30 jours d’avant : 100 ₩ \(5 ventes\)$/);
});

test('repère 1 : pas assez de ventes pour comparer', () => {
  const { t } = load();
  const m = sales => t.cardCues(sales, NOW, null).moment.state;
  assert.equal(m([sale(1, 130), sale(2, 130), ...base5(100)]), 'few', '2 ventes sur 7 jours');
  assert.equal(m([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100).slice(0, 4)]), 'few', '4 ventes sur les 30 jours d’avant');
  assert.equal(nb(t.cueLines(t.cardCues([sale(1, 130)], NOW, null))[0].text), 'pas assez de ventes pour comparer');
});

test('repère 2 : en hausse, en baisse, stable', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope;
  let c = s(trend(0.10));
  assert.equal(c.state, 'up'); assert.ok(c.pct >= 9 && c.pct <= 11, String(c.pct));
  c = s(trend(-0.10));
  assert.equal(c.state, 'down'); assert.ok(c.pct <= -9 && c.pct >= -11, String(c.pct));
  assert.equal(s(trend(0.01)).state, 'flat');
  assert.equal(nb(t.cueLines(t.cardCues(trend(-0.10), NOW, null))[1].text), 'en baisse (−10 % par semaine)');
});

test('repère 2 : une vente aberrante ne renverse pas le sens ; moins de 6 ventes, pas de sens', () => {
  const { t } = load();
  const s = sales => t.cardCues(sales, NOW, null).slope.state;
  assert.equal(s([sale(0.5, 50000), ...trend(-0.10)]), 'down');
  assert.equal(s(trend(0.10, 5)), 'few');
});

test('repère 3 : environ N fois par semaine, par mois, ou aucune vente en 30 jours', () => {
  const { t } = load();
  const pace = sales => nb(t.cueLines(t.cardCues(sales, NOW, null))[2].text);
  assert.equal(pace(Array.from({ length: 9 }, (_, i) => sale(1 + i * 3, 100))), 'se vend environ 2 fois par semaine · dernière vente il y a 1 j');
  assert.match(pace([sale(2, 100), sale(9, 100), sale(20, 100)]), /^se vend environ 3 fois par mois · /);
  assert.equal(pace([sale(40, 100), sale(45, 100)]), 'aucune vente en 30 jours · dernière vente il y a 40 j');
});

test('repère 4 : la concurrence à la bonne rareté seulement, avec l’âge du relevé', () => {
  const { t } = load();
  const list = [{ a: 120, b: false, r: 'SR', i: 'A1' }, { a: 50, b: true, r: 'UR', i: 'A2' }, { a: 150, b: false, r: 'SR', i: 'A3' }];
  const line = asks => nb(t.cueLines(t.cardCues([sale(1, 100)], NOW, asks)).find(l => l.k === 'compete').text);
  assert.equal(line({ list, rarity: 'SR', seenAt: NOW - 2 * 36e5 }), '2 en vente, la moins chère à 120 ₩ · relevé il y a 2 h');
  assert.equal(line({ list: list.slice(1, 2), rarity: 'SR', seenAt: NOW - 3 * 36e5 }), 'aucune annonce connue à cette rareté (relevé il y a 3 h)');
  assert.equal(line({ list: [], rarity: 'SR', seenAt: 0 }), 'annonces jamais cherchées');
  assert.equal(t.cueLines(t.cardCues([sale(1, 100)], NOW, null)).some(l => l.k === 'compete'), false);
});

test('repères en court pour la bulle', () => {
  const { t } = load();
  assert.equal(nb(t.cueShort(t.cardCues([sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)], NOW, null))), 'plus cher que d’habitude · en hausse');
  assert.equal(t.cueShort(t.cardCues([sale(1, 100)], NOW, null)), '');
});

test('repères : date illisible ignorée, date future comptée comme maintenant, ventes à la même date', () => {
  const { t } = load();
  const odd = [{ p: 100, t: 'n/a', r: 'SR' }, sale(-2, 130), sale(1, 130), sale(2, 130), ...base5(100)];
  const c = t.cardCues(odd, NOW, null);
  assert.equal(c.moment.n7, 3);
  assert.equal(c.moment.state, 'high');
  const same = Array.from({ length: 8 }, () => sale(3, 100));
  assert.equal(t.cardCues(same, NOW, null).slope.state, 'few', 'aucune paire de dates différentes');
  for (const s of [odd, same]) assert.doesNotMatch(t.cueLines(t.cardCues(s, NOW, null)).map(l => l.text).join(' '), /NaN|undefined|Infinity/);
});
```

Ajouter `'cardCues', 'cueLines', 'cueShort'` à `EXPOSE`.

- [ ] **Step 2: Lancer les tests, les voir échouer**

Run: `node --test test/fiche-carte.test.js`
Expected: FAIL, `t.cardCues is not a function` (les 3 tests de la tâche 1 restent verts).

- [ ] **Step 3: Écrire `CUE`, `cardCues`, `cueLines`, `cueShort`**

- [ ] **Step 4: Lancer les tests de la tâche et toute la suite**

Run: `node --test test/fiche-carte.test.js` puis `node --test test/*.test.js`
Expected: PASS partout.

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js test/harness.js test/fiche-carte.test.js
git commit -m "Fiche : repères (prix du moment, sens, rythme, concurrence)"
```

---

### Task 3: La fiche dans le panneau

**Files:**
- Modify: `wikimasters-stats.user.js` : `ui` (champ `card`), `CSS`, `mount`, `setTab`, `toggle`, `refresh`, `syncButtons`, `COLS` (colonne Carte), `renderSell` et `renderWish` (colonne Carte), nouvelles fonctions près de `renderSell`
- Modify: `test/harness.js`, `test/fiche-carte.test.js`

**Interfaces:**
- Consumes: `cardSource`, `cardRarities` (tâche 1) ; `cardCues`, `cueLines` (tâche 2) ; `priceOf`, `valueOf`, `askOf`, `priceForAsk`, `dealPct`, `maxBid`, `originOf`, `originText`, `profitTag`, `relCell`, `rarBadge`, `sortTable`, `marketSearch`, `fetchPricesFor`, `proState`, `job`, `setStatus`, `db.wishSeen`.
- Produces:
  - `ui.card` : `null` (fiche fermée) ou `{ id, rarity, title, au, from, period, all }` ; `au` = l'annonce (`{ a, b, r, i, s? }`) ou `null` ; `from` = l'onglet d'origine ; `period` = `null` (par défaut) ou une période de la tâche 4 ; `all` = liste complète affichée.
  - `openCard(cardId, opts) -> void`, `opts = { rarity?, au?, title? }`. Rareté : `opts.rarity` si valide, sinon celle d'un exemplaire à toi de la carte (non shiny d'abord), sinon `rarityOf(cardId)`, sinon `cardRarities(cardId)[0]`, sinon `''`. `from` garde l'onglet d'origine si une fiche est déjà ouverte. Vide la ligne d'état de la fiche (`setStatus('', 'cardStatus')`). Puis `showView()` ; avec le panneau monté (`ui.el.host`) : `toggle(true)` s'il est fermé, sinon `refresh()`.
  - `closeCard() -> void` : `setTab(ui.card ? ui.card.from : ui.tab)`.
  - `showView() -> void` : sans `ui.el.host`, ne fait rien ; sinon affiche `view_card` si `ui.card`, sinon la vue de `ui.tab`, et allume le bouton d'onglet seulement sans fiche.
  - `setTab(t)` : met `ui.card = null`, puis `ui.tab = t`, `showView()`, `refresh()` (le code d'affichage actuel passe dans `showView`).
  - `toggle(false)` ferme aussi la fiche (`ui.card = null`, `showView()`).
  - `refresh()` appelle `renderCard()` à la place du rendu de l'onglet quand `ui.card`.
  - `cardTitle(cardId, fallback) -> string` : titre d'un exemplaire de `db.cards`, sinon `db.wish[cardId][0]`, sinon `fallback`, sinon `'?'`.
  - `cardBtn(cardId, rarity, title) -> HTMLButtonElement` : bouton `📈` (classe `cbtn`, `title: 'Fiche de la carte : repères, courbe et ventes'`) qui appelle `openCard(cardId, { rarity, title })`.
  - `renderCard() -> void` : remplit `ui.el.cardHead` et `ui.el.cardBody` (`replaceChildren`) ; crée les boutons `ui.el.cardSearch` et `ui.el.cardPro` (ce dernier seulement si `proState() === true`).
  - `syncCardButtons() -> void` : `cardSearch.disabled = job.running || !ui.card || ui.card.title === '?'` ; `cardPro.disabled = job.running`. Appelée par `renderCard` et par `syncButtons` **avant** son `if (!e.load) return;`. Les propriétés `disabled` s'affectent directement sur l'élément (pas par les props de `h`).
  - Éléments de `mount` : `e.view_card` (caché au départ) contenant `e.cardHead`, `e.cardStatus` (ligne d'état, ajoutée à la liste des `status`), `e.cardBody` (classe `scroll`) ; `views` = vues de `TABS` puis `e.view_card`.

Contenu de la fiche :
- **En-tête :** bouton `← Retour` (`closeCard`) ; le nom ; une pastille par rareté de `cardRarities` plus la rareté affichée (boutons `rarBadge`, celle affichée marquée ; un clic change `ui.card.rarity`, remet `period` à `null` et `all` à `false`, puis `renderCard()`) ; la valeur comme partout : `priceOf(id, rarity)` avec ventes → `(≈ si fiabilité 0) X ₩` (X = `Math.round(Math.max(med, DISCARD))`) puis `relCell(price)`, et ` · prix d’autres raretés` si `price.mixed` ; sinon (pas de prix du tout, ou aucune vente) → `1 ₩ (aucune vente connue)`.
- **Corps, sans vente de la source** : `Aucune vente connue à cette rareté.` (sans « à cette rareté » quand la rareté est vide) ; puis, s'il y en a, `Ventes connues en : ` suivi des pastilles des autres raretés. Aucun prix d'une autre rareté dans le corps.
- **Corps, avec ventes :** une ligne par élément de `cueLines(cardCues(src.sales, Date.now(), { list: ask ? ask.list : [], rarity, seenAt }))`, avec `ask = askOf(id, rarity)` et `seenAt = db.wishSeen[id] || (ask && ask.t) || 0`, sous la forme `<b>libellé :</b> texte` dans des `div` (pas de tableau).
  - `Pour toi :` si tu as un exemplaire non shiny de la carte à cette rareté : `originText(o)` avec `o = originOf(id, rarity, false, Date.now())`, puis ` · la vendre à sa valeur : ` et `profitTag(valueOf(id, rarity) - o.cost, o.approx)`.
  - `Face à l’annonce :` si `ui.card.au` : annonce shiny (`au.s`) → `carte shiny : le site ne distingue pas les ventes shiny, pas de comparaison` ; sans vente à sa rareté → `aucune vente connue à sa rareté` ; sinon, avec `p = priceForAsk(id, au, priceOf(id, rarity))`, `med = Math.max(p.med, DISCARD)` et `pct = Math.round(100 * (au.a / med - 1))` : `annonce à X ₩, ` + (`pct < 0` → `−pct % sous la valeur`, `pct > 0` → `pct % au-dessus de la valeur`, sinon `au niveau de la valeur`), puis l'étiquette `bonne affaire −D %` si `D = dealPct(au, p)`, puis ` · enchère max conseillée : ` + `fmt(maxBid(p))` + ` ₩`.
  - La liste : `sortTable('card', cols, src.sales, renderCard, { limit: ui.card.all ? 0 : 50 })`, colonnes `Date` (`fmtDate`, tri sur la date), `Prix`, `Rareté` (`rarBadge`), `Sorte` (`Pro` pour la source `pro`, `toi` pour `own`, `exacte` ou `provisoire` selon `s.x` pour `obs`) ; puis, si plus de 50 ventes et pas `all`, un bouton `Tout afficher (N)` qui met `all` à vrai et redessine.
- **Actions** (toujours présentes, avec ou sans ventes) : `Chercher les annonces de cette carte` → si `!job.running`, `await marketSearch([[id, title]], 'Annonces', 'sans annonce', 'cardStatus')` ; `Relever l’historique Pro` (compte Pro seulement) → `await fetchPricesFor([[id, rarity]], 'cardStatus', 'carte', 'cartes')`. Après chacune, `renderCard()` si la même carte est encore ouverte.
- **Boutons 📈** : `cardBtn` juste après le nom, dans la colonne Carte de `COLS` (`r.cardId, r.rarity, r.title`), de `renderSell` (`r.cardId, r.rarity, r.title`) et de `renderWish` (`c.id, c.rarity, c.title`). Le lien du nom ne change pas.
- **CSS** : classes `cbtn` (bouton discret, sans bordure), `card-head`, `cues`, `cue`, et l'état allumé d'une pastille de rareté ; mise en page laissée au développeur, dans le style du panneau.

- [ ] **Step 1: Écrire les tests qui échouent**

```js
// Faux éléments de la fiche ; renvoie une fonction qui lit tout son texte.
function fiche(t) {
  const out = {};
  for (const k of ['cardHead', 'cardBody']) t.ui.el[k] = { replaceChildren(...kids) { out[k] = kids; } };
  t.ui.el.cardStatus = { textContent: '' };
  return Object.assign(() => nb(textOf([out.cardHead, out.cardBody])), { out });
}

test('fiche : repères, ce que la carte t’a coûté et ce que la vendre rapporterait', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120), sale(2, 120), sale(3, 120), ...base5(100)] };
  t.db.cards.X1 = { cardId: 'C1', title: 'Paris', rarity: 'SR', count: 1, shiny: false };
  t.db.auctions.B1 = ['b', 'C1', 'Paris', 'SR', 50, 80, 80, iso(20), 0];
  const text = fiche(t);
  t.openCard('C1');
  t.renderCard();
  const s = text();
  assert.match(s, /Paris/);
  assert.match(s, /Prix du moment/);
  assert.match(s, /plus cher que d’habitude \(\+20 %\)/);
  assert.match(s, /achetée 80 ₩/);
  assert.match(s, /\+40 ₩/);
  assert.doesNotMatch(s, /\b(vends|achète)\b/i);
});

test('fiche ouverte depuis une annonce : écart à la valeur, bonne affaire et enchère max', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120), sale(2, 120), sale(3, 120)] };
  const text = fiche(t);
  t.openCard('C1', { rarity: 'SR', au: { a: 70, b: false, r: 'SR', i: 'A1' }, title: 'Paris' });
  t.renderCard();
  const s = text();
  assert.match(s, /Face à l’annonce/);
  assert.match(s, /42 % sous la valeur/);
  assert.match(s, /bonne affaire −42 %/);
  assert.match(s, /enchère max conseillée : 120 ₩/);
});

test('fiche : aucune vente à cette rareté, pas de mélange, et les raretés qui en ont', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 900, 'UR'), sale(2, 950, 'UR')] };
  const text = fiche(t);
  t.openCard('C1', { rarity: 'SR', title: 'Paris' });
  t.renderCard();
  const s = text();
  assert.match(s, /Aucune vente connue à cette rareté/);
  assert.match(s, /Ventes connues en : .*UR/);
  assert.doesNotMatch(s, /\b(900|950)\b/, 'aucune vente UR listée comme vente SR');
});

test('fiche : les 50 ventes les plus récentes, puis toutes', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: Array.from({ length: 80 }, (_, i) => sale(i * 0.5, 100 + i)) };
  const text = fiche(t);
  t.openCard('C1', { rarity: 'SR', title: 'Paris' });
  t.renderCard();
  const rows = () => find(text.out.cardBody, n => n.tagName === 'tbody').reduce((a, b) => a + b.children.length, 0);
  assert.equal(rows(), 50);
  assert.match(text(), /Tout afficher \(80\)/);
  t.ui.card.all = true;
  t.renderCard();
  assert.equal(rows(), 80);
});

test('fiche : ← Retour et un onglet ramènent à l’onglet d’origine, fermer le panneau ferme la fiche', () => {
  const { t } = load();
  t.ui.el.back = { classList: { toggle() {} } };
  t.ui.tab = 'wish';
  t.openCard('C1', { title: 'Paris' });
  assert.equal(t.ui.card.from, 'wish');
  t.closeCard();
  assert.equal(t.ui.card, null);
  assert.equal(t.ui.tab, 'wish');
  t.openCard('C1', { title: 'Paris' });
  t.setTab('col');
  assert.equal(t.ui.card, null);
  assert.equal(t.ui.tab, 'col');
  t.openCard('C1', { title: 'Paris' });
  t.ui.open = true;
  t.toggle(false);
  assert.equal(t.ui.card, null);
});

test('fiche : actions grisées pendant un autre traitement, et recherche impossible sans le nom', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120)] };
  fiche(t);
  t.openCard('C1', { rarity: 'SR', title: 'Paris' });
  t.job.running = true;
  t.renderCard();
  assert.equal(t.ui.el.cardSearch.disabled, true);
  t.job.running = false;
  t.syncButtons();
  assert.equal(t.ui.el.cardSearch.disabled, false);
  t.openCard('C9', { rarity: 'SR' });
  t.renderCard();
  assert.equal(t.ui.el.cardSearch.disabled, true, 'nom inconnu : la recherche par nom est impossible');
});

test('fiche d’une carte inconnue partout : aucune vente, pas de plantage', () => {
  const { t } = load();
  const text = fiche(t);
  t.openCard('C404');
  t.renderCard();
  assert.match(text(), /Aucune vente connue/);
  assert.doesNotMatch(text(), /NaN|undefined|Infinity/);
});
```

Ajouter `'openCard', 'closeCard', 'renderCard', 'setTab', 'toggle', 'syncButtons'` à `EXPOSE`.

- [ ] **Step 2: Lancer les tests, les voir échouer**

Run: `node --test test/fiche-carte.test.js`
Expected: FAIL, `t.openCard is not a function`.

- [ ] **Step 3: Écrire la vue, son état, `renderCard`, les actions et les boutons 📈**

- [ ] **Step 4: Lancer les tests de la tâche et toute la suite**

Run: `node --test test/fiche-carte.test.js` puis `node --test test/*.test.js`
Expected: PASS partout.

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js test/harness.js test/fiche-carte.test.js
git commit -m "Fiche : vue du panneau, repères, gain, annonce, liste des ventes, actions et boutons 📈"
```

---

### Task 4: La courbe

**Files:**
- Modify: `wikimasters-stats.user.js` (fonctions près de `renderCard`, et `renderCard` lui-même)
- Modify: `test/harness.js`, `test/fiche-carte.test.js`

**Interfaces:**
- Consumes: `s` (SVG), `fmt`, `fmtDate`, `cardSource`, `cardCues` (`moment.med7`, `moment.medBase`, `null` en dessous des minimums), `ui.card.period`.
- Produces:
  - `CHART_PERIODS = [['7', '7 j', 7], ['30', '30 j', 30], ['90', '90 j', 90], ['all', 'tout', 0]]`.
  - `defaultPeriod(sales, now) -> '30'|'all'` : `'30'` si au moins 10 ventes d'âge ≤ 30 jours, sinon `'all'`.
  - `chartBounds(values) -> [lo, hi]` : moins de 10 valeurs → `[min, max]` ; sinon 2ᵉ et 98ᵉ centiles par interpolation linéaire sur les valeurs triées (`i = f * (n - 1)`). Si `hi - lo < 1` : `[lo - 1, hi + 1]`.
  - `cardMarks(cardId, rarity) -> [{ t, p, k: 's'|'b' }]` : tes ventes (`s`) et achats (`b`) de `db.auctions` à prix connu, non shiny, à cette rareté ou de rareté inconnue, date lisible ; du plus ancien au plus récent.
  - `cardChart(points, marks, period, now, lines) -> SVGElement`. `points` : `[{ t (ms), p, k: 'pro'|'exact'|'prov'|'own' }]` ; `lines` : `{ med7, medBase }` (chacun peut être `null`). Rendu en `viewBox` 760 × 220, `width: 100%`.
    - Axe des dates réel : `[now − jours, now]`, ou pour `all` de la plus ancienne vente ou marque jusqu'à `now`. Axe des prix : `chartBounds` des prix visibles (ventes et marques) ; une valeur hors bornes est dessinée au bord, en rouge (`#f87171`).
    - Chaque vente : un `circle` ; plein (`fill: '#34d399'`) pour `pro`, `exact` et `own`, creux (`fill: 'none'`, contour vert) pour `prov`. Chaque marque : un `path` en losange, bleu (`#60a5fa`) pour une vente à toi, orange (`#f59e0b`) pour un achat. Aucun autre élément n'est un `circle` ni un `path` (axes et repères en `line` et `text`).
    - `medBase` : un `line` en pointillés (`stroke-dasharray: '4 4'`) de `max(début, now − 37 j)` à `now − 7 j` ; `med7` : un `line` plein de `max(début, now − 7 j)` à `now`. Aucun autre élément n'a de `stroke-dasharray`. Chaque segment n'est dessiné que si sa valeur existe et s'il tombe dans la période.
    - Survol : un `title` dans chaque point, `date · X ₩ · sorte` avec la sorte `Pro`, `exacte`, `provisoire`, `toi`, ou `ta vente` / `ton achat` pour une marque.
    - Deux prix (haut et bas de l'axe) à gauche, deux dates (début et fin) en bas. Sans point dans la période : un texte `aucune vente sur cette période`.
  - `renderCard` (avec ventes) : sous les repères, les quatre boutons de période (celui en cours allumé ; un clic met `ui.card.period` et redessine), puis `cardChart` avec `period = ui.card.period || defaultPeriod(src.sales, now)`, les points tirés de la source (`pro` → `pro`, `own` → `own`, `obs` → `exact` si `s.x`, sinon `prov`), `cardMarks(id, rarity)` et les médianes du repère 1 ; une légende courte sous la courbe (point plein, point creux = provisoire, un minimum ; losanges = tes ventes et tes achats ; pointillés = médiane des 30 jours d’avant).

- [ ] **Step 1: Écrire les tests qui échouent**

```js
test('courbe : axe des prix borné aux 2e et 98e centiles, sauf avec peu de ventes', () => {
  const { t } = load();
  const [lo, hi] = t.chartBounds(Array.from({ length: 49 }, (_, i) => 100 + i).concat([10000]));
  assert.ok(lo >= 100 && lo < 102, String(lo));
  assert.ok(hi >= 148 && hi < 1000, 'la vente aberrante ne fixe pas le haut de l’axe : ' + hi);
  assert.deepEqual(plain(t.chartBounds([10, 1000, 500])), [10, 1000]);
  assert.deepEqual(plain(t.chartBounds([100, 100, 100])), [99, 101]);
});

test('courbe : 30 jours par défaut, tout s’il y a moins de 10 ventes en 30 jours', () => {
  const { t } = load();
  assert.equal(t.defaultPeriod(Array.from({ length: 10 }, (_, i) => sale(i, 100)), NOW), '30');
  assert.equal(t.defaultPeriod(Array.from({ length: 9 }, (_, i) => sale(i, 100)).concat([sale(60, 100)]), NOW), 'all');
});

test('courbe : tes ventes et achats à la rareté affichée, sans les shiny ni les invendues', () => {
  const { t } = load();
  t.db.auctions = {
    S1: ['s', 'C1', 'Paris', 'SR', 50, 50, 130, iso(3), 0],
    B1: ['b', 'C1', 'Paris', 'SR', 50, 50, 90, iso(9), 0],
    B2: ['b', 'C1', 'Paris', 'UR', 50, 50, 900, iso(5), 0],
    B3: ['b', 'C1', 'Paris', 'SR', 50, 50, 400, iso(4), 1],
    U1: ['u', 'C1', 'Paris', 'SR', 50, 50, null, iso(2), 0]
  };
  assert.deepEqual(plain(t.cardMarks('C1', 'SR')).map(m => [m.k, m.p]), [['b', 90], ['s', 130]]);
});

test('courbe : point creux pour un provisoire, segments des deux médianes, détail au survol', () => {
  const { t } = load();
  const pts = [{ t: NOW - DAY, p: 120, k: 'pro' }, { t: NOW - 2 * DAY, p: 110, k: 'prov' }, { t: NOW - 12 * DAY, p: 100, k: 'exact' }];
  const svg = t.cardChart(pts, [{ t: NOW - 3 * DAY, p: 115, k: 's' }], '30', NOW, { med7: 115, medBase: 100 });
  const circles = find(svg, n => n.tagName === 'circle');
  assert.equal(circles.length, 3);
  assert.equal(circles.filter(c => c.attrs.fill === 'none').length, 1, 'le provisoire est creux');
  assert.equal(find(svg, n => n.tagName === 'line' && n.attrs['stroke-dasharray']).length, 1, 'médiane des 30 jours d’avant en pointillés');
  assert.equal(find(svg, n => n.tagName === 'path').length, 1, 'ta vente en losange');
  assert.match(nb(textOf(svg)), /provisoire/);
  assert.match(nb(textOf(svg)), /ta vente/);
});

test('courbe : ventes toutes au même prix, l’axe ne s’écrase pas', () => {
  const { t } = load();
  const svg = t.cardChart([1, 2, 3].map(d => ({ t: NOW - d * DAY, p: 100, k: 'pro' })), [], '30', NOW, { med7: null, medBase: null });
  for (const c of find(svg, n => n.tagName === 'circle')) assert.ok(Number.isFinite(Number(c.attrs.cy)), c.attrs.cy);
});
```

Ajouter `'chartBounds', 'defaultPeriod', 'cardMarks', 'cardChart'` à `EXPOSE`.

- [ ] **Step 2: Lancer les tests, les voir échouer**

Run: `node --test test/fiche-carte.test.js`
Expected: FAIL, `t.chartBounds is not a function`.

- [ ] **Step 3: Écrire `CHART_PERIODS`, `defaultPeriod`, `chartBounds`, `cardMarks`, `cardChart`, et les brancher dans `renderCard`**

- [ ] **Step 4: Lancer les tests de la tâche et toute la suite**

Run: `node --test test/fiche-carte.test.js` puis `node --test test/*.test.js`
Expected: PASS partout (dont les tests de la tâche 3 : le corps de la fiche n'a toujours qu'un seul `tbody`).

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js test/harness.js test/fiche-carte.test.js
git commit -m "Fiche : courbe des ventes (axe réel, périodes, médianes, provisoires, tes ventes et achats)"
```

---

### Task 5: Pastilles et bulle, version 1.29.0

**Files:**
- Modify: `wikimasters-stats.user.js` : `badgeFor`, `scanCards`, `startOverlay`, nouvelles fonctions `cuesOf` et `badgeClick` près de `badgeFor`, en-tête `@version` et repli de `VERSION`
- Modify: `README.md` (section « Valeur sur les cartes du site », nouvelle section « Fiche d’une carte » juste après)
- Modify: `test/harness.js`, `test/fiche-carte.test.js`

**Interfaces:**
- Consumes: `cardSource`, `cardCues`, `cueShort`, `openCard`, `tipData`, `hideTip`, `BADGE`, `rarOk`.
- Produces:
  - `cuesOf(cardId, rarity) -> Cues|null` : `cardCues(cardSource(cardId, rarity).sales, Date.now(), null)` ; `null` sans vente. Cache dans une `Map` à part (pas vidée par `resetPrices`), clé `cardId|rarity`, entrée valable tant que la signature des ventes ne change pas (`kind`, nombre de ventes, date de la plus récente) et au plus 10 minutes ; la `Map` est vidée quand elle dépasse 2 000 entrées.
  - `badgeFor(cardId, au, mine)` rend en plus `card: { id: cardId, au: au || null }`. Ses lignes gagnent :
    - `Repères : ` + `cueShort(cuesOf(cardId, r))`, avec `r = au && rarOk(au.r) ? au.r : rarityOf(cardId)`, juste après la ligne « Valeur : … » et la ligne de l'autre valeur, seulement si le texte court n'est pas vide ;
    - `Clic : fiche de la carte`, toujours, en dernière ligne.
  - `scanCards` : `b.card.title = title` avant `tipData.set(el, b)` ; le style de la pastille passe de `cursor:help` à `cursor:pointer`.
  - `badgeClick(ev) -> void` : `el = ev.target && ev.target.closest ? ev.target.closest('.' + BADGE) : null` ; sans `el`, rien. Sinon `ev.preventDefault()`, `ev.stopPropagation()`, `hideTip()`, puis, si `tipData.get(el)` a une `card` : `openCard(card.id, { rarity: au && rarOk(au.r) ? au.r : undefined, au: au && au.a != null ? au : null, title: card.title })`.
  - `startOverlay` : `document.addEventListener('click', badgeClick, true)` (phase de capture, avant le lien de la carte du site).
  - README : la section « Valeur sur les cartes du site » dit que la bulle montre les repères en court et qu'un clic sur la pastille ouvre la fiche ; la nouvelle section « Fiche d’une carte » décrit comment l'ouvrir (📈 dans Collection, À vendre et Souhaits ; clic sur une pastille), les six repères et leurs seuils, la courbe, la liste et les deux actions, et rappelle que ce sont des repères, pas des conseils.

- [ ] **Step 1: Écrire les tests qui échouent**

```js
test('bulle : les repères en court, et le clic vers la fiche', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 130), sale(2, 130), sale(3, 130), ...base5(100)] };
  const lines = t.badgeFor('C1', null, {}).lines.map(nb);
  assert.ok(lines.includes('Repères : plus cher que d’habitude · en hausse'), lines.join('\n'));
  assert.equal(lines[lines.length - 1], 'Clic : fiche de la carte');
});

test('bulle : sans assez de ventes, pas de ligne de repères', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 130), sale(2, 120)] };
  const lines = t.badgeFor('C1', null, {}).lines;
  assert.ok(!lines.some(l => l.startsWith('Repères')));
  assert.ok(lines.includes('Clic : fiche de la carte'));
});

test('bulle : de nouvelles ventes changent les repères sans attendre', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 100), sale(2, 100), sale(3, 100), ...base5(100)] };
  assert.ok(t.badgeFor('C1', null, {}).lines.map(nb).includes('Repères : dans son habitude · stable'));
  t.mergePro([['C1', NOW, [[150, iso(0.5), 'SR'], [150, iso(0.6), 'SR'], [150, iso(0.7), 'SR'], [150, iso(0.8), 'SR']]]]);
  assert.ok(t.badgeFor('C1', null, {}).lines.map(nb).some(l => /^Repères : plus cher que d’habitude/.test(l)));
});

test('clic sur une pastille : la fiche s’ouvre à la rareté de l’annonce, sans suivre le lien du site', () => {
  const { t } = load();
  t.db.prices.C1 = { at: NOW, sales: [sale(1, 120, 'UR'), sale(2, 100, 'SR')] };
  t.db.cards.X1 = { cardId: 'C1', title: 'Paris', rarity: 'SR', count: 1, shiny: false };
  t.ui.tab = 'col';
  const b = t.badgeFor('C1', { a: 90, b: false, r: 'UR', i: 'A1' }, {});
  assert.equal(b.card.id, 'C1');
  b.card.title = 'Paris';
  const el = {};
  t.tipData.set(el, b);
  const calls = [];
  t.badgeClick({ target: { closest: () => el }, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  assert.deepEqual(calls, ['prevent', 'stop']);
  assert.equal(t.ui.card.id, 'C1');
  assert.equal(t.ui.card.rarity, 'UR', 'la rareté de l’annonce, comme la pastille');
  assert.equal(t.ui.card.au.a, 90);
  assert.equal(t.ui.card.from, 'col');
});

test('clic ailleurs sur la page : rien n’est intercepté', () => {
  const { t } = load();
  const calls = [];
  t.badgeClick({ target: { closest: () => null }, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  assert.deepEqual(calls, []);
  assert.equal(t.ui.card, null);
});
```

Ajouter `'badgeClick', 'tipData'` à `EXPOSE`.

- [ ] **Step 2: Lancer les tests, les voir échouer**

Run: `node --test test/fiche-carte.test.js`
Expected: FAIL (pas de ligne « Repères », `t.badgeClick is not a function`).

- [ ] **Step 3: Écrire `cuesOf`, les lignes de la bulle, `badgeClick`, l'écouteur, le curseur ; passer en 1.29.0 ; mettre le README à jour**

- [ ] **Step 4: Lancer les tests de la tâche et toute la suite**

Run: `node --test test/fiche-carte.test.js` puis `node --test test/*.test.js`
Expected: PASS partout. Les tests existants sur les lignes de la bulle (`test/ventes-completes.test.js`, `test/rarete.test.js`) restent verts : ils cherchent des lignes précises, ils ne comptent pas les lignes.

- [ ] **Step 5: Commit**

```bash
git add wikimasters-stats.user.js README.md test/harness.js test/fiche-carte.test.js
git commit -m "v1.29.0 : fiche par carte, ouverte depuis le panneau et par clic sur une pastille ; repères dans la bulle"
```
