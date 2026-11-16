# Mes ventes en cours — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** garder la liste complète de tes annonces en cours, et afficher leur bilan en haut de l'onglet Mes ventes.

**Architecture :** `db.selling` est rempli dans `ingestMarket`. `sellingRows()` et `sellingStats(rows)` calculent le bilan, et `renderSelling()` l'affiche. `renderSales` place ce bloc en tête.

**Tech stack :** userscript sans dépendance, `node:test`.

**Spec :** `docs/superpowers/specs/2026-11-16-ventes-en-cours-design.md`

## Global Constraints

- **Champs d'une annonce** `{ i, c, t, r, base, l, o, b, e, s }` :
  - `i` : l'enchère ; `c` : la carte ; `t` : le titre ;
  - `r` : la rareté de l'exemplaire ;
  - `base` : la mise de départ actuelle ; `l` : celle d'origine ;
  - `o` : l'offre (`effective_bid` sinon `current_bid`), ou `null` sans offre ;
  - `b` : une offre a été faite ;
  - `e` : la fin en millisecondes, `0` si inconnue ;
  - `s` : 1 pour une shiny.
- **Plafond** : 50 annonces. `db.selling` et `db.sellingAt` sont personnels (`PERSONAL`).
- **Version** 1.21.0, textes en français.

## Review Focus

1. **Page du Marché sans `selling`** (pages suivantes, recherche) : la liste n'est pas effacée. Testé.
2. **Annonce shiny** : exclue de la valeur, de l'écart et de « sous la valeur ». Testé.
3. **Carte sans prix connu** : écart « — », comptée parmi les cartes sans prix, pas dans « sous la valeur ». Testé.
4. **Aucune enchère terminée en mémoire, mais des annonces en cours** : le bloc s'affiche quand même. Testé.
5. **Changement de compte** : les annonces de l'autre compte n'apparaissent pas. Testé.

---

### Task 1 : stockage, bilan et affichage

- [ ] **Tests** (`test/ventes-en-cours.test.js`) :
  - `ingestMarket({ selling: [...] })` remplit `db.selling` avec les champs ci-dessus et garde `db.market.selling` = les identifiants des cartes. `ingestMarket({ auctions: [] })` ne touche pas à `db.selling`.
  - `sellingStats(sellingRows())` sur 4 annonces (une avec une offre au-dessus de la valeur, une avec une offre en dessous, une sans offre avec une mise de départ trop haute, une shiny) et une annonce terminée :
    - `live` 4, `withOffer` 3 (la shiny compte : son offre est bien réelle), `overBase` 3 ;
    - `revenue` égal à la somme des offres ;
    - `value` sans la shiny, `below` 1, `highBase` 1.
  - `renderSales` avec `db.auctions` vide et deux annonces en cours : le texte rendu contient « Mes ventes en cours » et le titre des cartes.
  - `setAccount` : `db.selling` du compte U1 n'apparaît pas sous U2.
- [ ] **Lancer** : échec.
- [ ] **Implémenter** : `defaults`, `PERSONAL`, `cleanDb`, le remplissage dans `ingestMarket`, puis `sellingRows`, `sellingStats` et `renderSelling`, et `renderSales`.
- [ ] **Lancer** : succès.

### Task 2 : textes, version, PR

- [ ] **README** (section Mes ventes), version 1.21.0 aux deux endroits.
- [ ] **Lancer** `node --check` et `node --test test/*.test.js`.
- [ ] **Commiter, pousser, ouvrir la PR.**
