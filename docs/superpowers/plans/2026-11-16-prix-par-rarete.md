# Prix par rareté — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** chaque vente et chaque annonce garde sa rareté, et la valeur d'une carte se calcule à partir des seules ventes de sa rareté.

**Architecture :**
- Un champ `r` sur chaque vente, et `keepPerRarity` pour garder 10 ventes par rareté.
- `priceOf(cardId, rarity)`, avec `rarityOf(cardId)` comme rareté par défaut.
- Un champ `r` sur chaque annonce, et `askOf(cardId, rarity)` qui préfère la rareté voulue.
- La rareté de chaque vente circule aussi dans le fichier ami et le pool, client et serveur.

**Tech stack :** userscript sans dépendance, serveur Node 24 + `node:sqlite` (fonctions de fenêtrage SQL).

**Spec :** `docs/superpowers/specs/2026-11-16-prix-par-rarete-design.md`

## Global Constraints

- **Rareté valide** : `/^[A-Z]{1,3}$/`. Sinon elle est inconnue (`r` absent localement, `null` dans les échanges).
- **Rétention** : 10 ventes par rareté, 40 au plus par carte, aussi bien pour l'historique Pro, les ventes observées que tes ventes.
- **Historique Pro** : on lit `j.sales` s'il n'est pas vide, sinon `j.recent`. La rareté vient de `s.rarity`.
- **Choix des ventes** pour une rareté : celles de cette rareté, sinon celles à rareté inconnue, sinon toutes (`mixed: true`, fiabilité notée « Douteux »).
- **Ordre des sources** : historique Pro, puis tes ventes, puis ventes observées. On prend la première qui fournit des ventes non mélangées, sinon la première qui en a.
- **Formats** : l'historique Pro devient `[[p, t, r], …]`, et la rareté arrive en position 6 de chaque vente observée (fichier ami et pool). Les anciens formats restent acceptés.
- **Textes** en français.
- **Tests** : `node --test test/*.test.js`.

## Review Focus

1. **Carte sans rareté connue** (jamais vue dans la collection, les souhaits ou le site) : la valeur reste celle de toutes les ventes, comme avant. Testé dans la tâche 2.
2. **Anciennes données sans rareté** mêlées à de nouvelles avec rareté : les ventes de la bonne rareté priment, et les anciennes servent de repli. Testé dans la tâche 2.
3. **Annonce d'une autre rareté moins chère** : elle n'est pas présentée comme le prix de la ligne, ni comme une bonne affaire au regard de la valeur de la ligne. Testé dans la tâche 3.
4. **Ancien fichier ami** (ventes sans rareté) importé après la mise à jour : accepté, rareté inconnue. Testé dans la tâche 1.
5. **Pool** : une vente envoyée avec sa rareté revient avec la même rareté. Testé dans la tâche 4.

---

### Task 1 : les ventes gardent leur rareté

**Files :** Modify `wikimasters-stats.user.js`. Create `test/rarete.test.js`. Modify `test/friend-pro.test.js` et `test/pool-client.test.js` (les entrées Pro deviennent des triplets).

**Interfaces (produites) :**
- `rarOk(r) → boolean`.
- `keepPerRarity(list, per = 10, max = 40) → list` : les ventes les plus récentes de chaque rareté, triées par date décroissante.
- Les ventes stockées (`db.prices[c].sales`, `db.obsSales[c]`, `db.mySales[c]`) peuvent porter `r`.
- `ingestSales(cardId, j, rarity)` lit `j.sales` d'abord. L'entrée envoyée au pool devient `['p', [card, at, [[p, t, r], …], rarity]]`.
- `addObserved(cardId, sale, rarity)` enregistre `sale.r` s'il est valide.

- [ ] **Tests** :
  - `ingestSales` avec 25 ventes L et 3 UR dans `sales`, et 10 ventes dans `recent` : on garde 10 L et 3 UR, avec `r`.
  - Les prix provisoires (`settleObserved`) et finaux (`ingestFinal`) portent `r` (la rareté de l'exemplaire).
  - `tidyAuctions` : `db.mySales[c]` porte `r` (pris dans `a[3]`).
  - Aller-retour par le fichier ami (`friendExport` puis `importFriend`) : `r` est conservé sur les ventes Pro et observées. Un ancien fichier sans `r` est accepté.
  - La sauvegarde conserve `r`.
- [ ] **Lancer** : échec.
- [ ] **Implémenter**, puis ajuster les attentes des anciens tests aux triplets.
- [ ] **Lancer** : succès.

### Task 2 : la valeur se calcule par rareté

**Files :** Modify `wikimasters-stats.user.js`, `test/rarete.test.js`.

**Interfaces :**
- `rarityOf(cardId) → string` : la rareté de la collection, sinon celle des souhaits, sinon celle vue sur le site (`seenRarity`, rempli par `/api/cards` et par le `card.rarity` des enchères), sinon `''`.
- `priceOf(cardId, rarity = rarityOf(cardId))` :
  - le cache est indexé par `carte|rareté` ;
  - le résultat gagne `mixed: boolean` et `r` (la rareté demandée).
- `relCell` et `badgeFor` ajoutent « aucune vente connue à cette rareté, prix d'autres raretés » quand `mixed` est vrai.
- Les appels qui ont une rareté propre la passent :
  - `buildRows` : la rareté de chaque exemplaire ;
  - les échanges : `c[2]` ;
  - Mes ventes : `a.rarity` ;
  - Mes enchères : `b.r` ;
  - la liste d'un ami : `c[1]` ;
  - le panneau booster : `c.rarity`.

- [ ] **Tests** :
  - `priceOf(C, 'L')` donne la médiane des seules ventes L ; `priceOf(C, 'UR')` celle des UR ; `priceOf(C, 'SR')` donne `mixed: true` et une fiabilité baissée.
  - `priceOf(C)` sans rareté, alors que la collection a C en L, donne la médiane L.
  - Des ventes anciennes sans `r` et pas de vente L : on prend les anciennes, sans `mixed`.
  - Un historique Pro qui n'a que des UR, et des ventes observées en L : `priceOf(C, 'L')` prend les ventes observées.
  - Une carte de rareté inconnue donne toutes les ventes, sans `mixed`.
  - Le `title` de `relCell` mentionne « autres raretés » quand le prix est mélangé.
- [ ] **Lancer** : échec. **Implémenter.** **Lancer** : succès.

### Task 3 : les annonces gardent leur rareté

**Files :** Modify `wikimasters-stats.user.js`, `test/rarete.test.js`.

**Interfaces :**
- Les éléments de `db.market.asks[c].list` et les entrées de `seenAuction` portent `r` (`snapshot_rarity`).
- `askOf(cardId, rarity = rarityOf(cardId)) → { a, b, e, i, r, t, list, other }` :
  - le prix affiché vient de la moins chère des annonces à la rareté voulue (ou de rareté inconnue), sinon de la moins chère de toutes ;
  - `list` contient toutes les annonces, chacune avec `r` ;
  - `other` compte les annonces d'une autre rareté.
- Bonne affaire, enchère max et marge comparent chaque annonce à `priceOf(c, annonce.r || rareté)`.
- Souhaits :
  - la ligne choisit son annonce parmi celles de la rareté voulue ;
  - dépliée, chaque annonce porte une étiquette de rareté (`rarBadge`) ;
  - si l'annonce de la ligne est d'une autre rareté, l'étiquette est aussi sur la ligne.
- Pastilles : `badgeFor` utilise la rareté de l'annonce (`au.r`).

- [ ] **Tests** :
  - Une carte L avec une annonce UR à 400 et une annonce L à 12 000 : `askOf(C, 'L').a === 12000`, `.other === 1`, et `list` contient les deux avec leur `r`.
  - Valeur L 13 000 et valeur UR 7 000 : `dealPct` pour l'annonce UR à 400, mesurée par rapport à la valeur UR, donne 94. Par rapport à la valeur L, ce serait 97, mais on ne compare jamais une UR à la valeur L.
  - `badgeFor(C, { a: 400, r: 'UR' }, {})` : la valeur affichée est la médiane UR.
- [ ] **Lancer** : échec. **Implémenter.** **Lancer** : succès.

### Task 4 : la rareté de chaque vente circule dans le pool

**Files :** Modify `server/validate.js`, `server/db.js`, `test/server-db.test.js`, `test/server-http.test.js`, `wikimasters-stats.user.js` (`poolPull`, `poolBackfill`), `test/pool-client.test.js`.

**Interfaces :**
- `parsePush` : une vente Pro `[p, t, r?]` donne `{ price, t, rarity: rarity(r) ?? rarity de l'entrée }`.
- `pullCards` :
  - `pro.sales` devient `[[p, t, r], …]` et `sales` devient `[[p, t, g, x, auction, r], …]` ;
  - on renvoie les 10 dernières par rareté, 40 au plus, avec `ROW_NUMBER() OVER (PARTITION BY COALESCE(rarity, '') ORDER BY sold_at DESC)`.
- Client : `poolPull` passe ces triplets à `mergePro` et ces ventes à `mergeObserved`, sans conversion. `poolBackfill` envoie `[p, t, r]`.

- [ ] **Tests** :
  - Serveur : un envoi avec des ventes Pro `[[50, T, 'L'], [7, T2, 'UR']]` donne au pull `pro.sales` avec la rareté de chacune. 12 ventes L et 3 ventes UR donnent 10 L et 3 UR au pull.
  - Client : `poolPull` conserve `r` dans `db.prices` et `db.obsSales`.
- [ ] **Lancer** : échec. **Implémenter.** **Lancer** : succès.

### Task 5 : textes et vérification

- [ ] **README** : dans « Comment lire les chiffres », la valeur est la médiane des ventes **à la rareté de la carte**, avec le repli expliqué. Dans Souhaits, l'étiquette de rareté des annonces.
- [ ] **Lancer** `node --check` et `node --test test/*.test.js` : tout passe.
