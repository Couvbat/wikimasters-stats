# Comptes et historique — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** séparer les données personnelles de chaque compte dans le navigateur, et garder plus de ventes pour les raretés de valeur.

**Architecture :** `PERSONAL` (liste des champs personnels), `splitDb()`, `applyPersonal()`, `setAccount(uid)`, et un `saveDb` qui écrit deux clés. `keepPerRarity` reçoit des plafonds par rareté, et `trimHistory()` sert de garde-fou.

**Tech stack :** userscript sans dépendance, `node:test`.

**Spec :** `docs/superpowers/specs/2026-11-16-comptes-historique-design.md`

## Global Constraints

- **Clés** : `wmstats.v1` pour la partie commune, `wmstats.v1.u.<uid>` pour la partie personnelle (`_` tant que le compte n'est pas reconnu).
- **Plafonds** : 20 ventes par rareté pour L, UR et SR, 10 sinon, 60 par carte. Le garde-fou ramène à 10 par rareté (30 par carte).
- **Enregistrement** : la partie personnelle d'abord. Si elle échoue, la partie commune n'est pas écrite.
- **Bouton d'effacement** : confirmation par un second clic dans les 5 s.
- **Textes** en français.

## Review Focus

1. **Collection rechargée juste après un changement de compte** : la collection de l'ancien compte n'est pas vidée. Testé dans la tâche 2.
2. **Ancienne sauvegarde à clé unique** au premier lancement : tout est conservé et réparti. Testé dans la tâche 2.
3. **Deux onglets, un par compte** : l'écouteur `storage` recharge la partie personnelle du compte enregistré dans la partie commune. Pas de test : la logique est la même que `loadDb`, testée.
4. **Navigateur plein** : l'enregistrement réussit après réduction de l'historique. Testé dans la tâche 1.
5. **Effacement** : les prix restent. Testé dans la tâche 2.

---

### Task 1 : historique par rareté et garde-fou

- [ ] **Tests** (`test/comptes.test.js`) :
  - `keepPerRarity` garde 20 L et 10 R, et 60 ventes au plus par carte.
  - Navigateur plein : `saveDb()` renvoie vrai après `trimHistory()`, avec un simulateur qui refuse plus de N caractères ; les L sont ramenées à 10.
  - Dans `test/rarete.test.js`, l'attente passe à 20 L.
- [ ] **Implémenter** `keepPerRarity(list, per, max = 60)` (par défaut, `KEEP_RARE = { L: 20, UR: 20, SR: 20 }`, sinon 10), `trimHistory()`, et le troisième essai de `saveDb`. Côté serveur, `pullCards` renvoie `rn <= 20`, `LIMIT 60`.

### Task 2 : données par compte

- [ ] **Tests** :
  - Changement de compte : U1 garde sa collection et ses ventes, U2 démarre vide, retour à U1 qui retrouve tout, et les prix sont communs.
  - Migration : une ancienne clé unique, avec `userId: 'U1'` et `cards`, est lue entière. Au premier enregistrement, `wmstats.v1.u.U1` contient `cards` et `wmstats.v1` n'en contient plus.
  - Compte inconnu : les données sous `_` passent au premier compte reconnu, et `wmstats.v1.u._` disparaît.
  - `ingestCollection` venant d'un autre compte, avec `replace` : la collection de l'ancien compte est conservée sous sa clé.
  - `clearAccount()` vide la partie personnelle et garde les prix.
  - Dans `test/friend-pro.test.js`, le test « navigateur plein » lit les amis dans la clé personnelle.
- [ ] **Implémenter** :
  - `PERSONAL`, `acctKey`, `personalDefaults`, `splitDb`, `applyPersonal`, `setAccount`, `clearAccount` ;
  - `loadDb`, qui exige seulement `prices` dans la partie commune et applique la partie personnelle ;
  - `saveDb`, qui écrit les deux clés ;
  - les appels depuis `ingestPro` et `ingestCollection` (compte détecté avant `replace`) ;
  - dans Réglages, la ligne « Compte » et le bouton d'effacement en deux temps.
- [ ] **Harnais** : option `storage` pour remplir le `localStorage` simulé au chargement.

### Task 3 : textes et vérification

- [ ] **README** : un paragraphe « Plusieurs comptes » (Réglages et Sauvegarde), et « Valeur » qui parle de 20 ventes pour L, UR et SR.
- [ ] **Lancer** `node --check` et `node --test test/*.test.js` : tout passe.
