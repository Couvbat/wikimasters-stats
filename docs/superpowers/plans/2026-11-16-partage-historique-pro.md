# Partage de l'historique Pro — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** le fichier ami transporte l'historique Pro et les ventes/achats de son auteur, et l'import les verse dans `db.prices` / `db.obsSales` pour remplir les tableaux.

**Architecture :** tout reste dans `wikimasters-stats.user.js`. L'export est extrait dans une fonction pure `friendExport(pseudo)`. L'import passe par une nouvelle fonction `mergePro(list, from)`. `priceOf` expose l'origine `by`, qu'affichent `relCell` et `badgeFor`.

**Tech stack :** userscript JS sans dépendance. Tests en Node 24 (`node:test`, `node:vm`) dans `test/friend-pro.test.js`. Le harnais charge le script dans un contexte simulé et expose ses fonctions internes.

**Spec :** `docs/superpowers/specs/2026-11-16-partage-historique-pro-design.md`

## Global Constraints

- Pas de dépendance npm : uniquement `node:test`, `node:assert` et `node:vm`.
- Textes visibles en français, dans le ton du README (tutoiement, phrases courtes).
- Version `1.19.0`, à deux endroits : l'en-tête `@version` et la constante `VERSION`.
- Champ du fichier ami `pro` : `[[cardId, at, [[p, t], …], by], …]`, non vides seulement, triés par `at` décroissant, 8000 au plus.
- Fichier ami : 20 Mo au plus (`2e7`).

## Review Focus

1. **Fichier forgé avec une date `at` dans le futur.** Elle est ramenée à `Date.now()`, sinon ce prix ne serait jamais remplacé. Testé dans la tâche 2.
2. **Mon propre relevé plus récent que celui de l'ami.** Le mien est gardé. Testé dans la tâche 2.
3. **`localStorage` plein au moment d'ajouter les prix Pro.** Ces prix sont annulés, l'ami reste importé, et le message le dit. Testé dans la tâche 2.
4. **Mes prix qui me reviennent par un ami** (`by` égal à `db.me`). Pas d'étiquette « partagé par » sur mes propres prix. Testé dans la tâche 2.
5. **Entrées malformées** (`by` qui n'est pas une chaîne, prix négatif, ventes vides, clé `__proto__`). Elles sont ignorées sans planter. Testé dans la tâche 2.

---

### Task 1 : harnais de test + export

**Files :** Create `test/friend-pro.test.js`. Modify `wikimasters-stats.user.js` (zone `exportMine`, ~l. 1261).

**Interfaces :**
- Produces : `friendExport(pseudo: string) → { wmstats: 1, pseudo, at, cards, wish, seen: { sales, rar }, pro }`. `exportMine()` l'appelle puis télécharge.
- Le harnais : `load(storage?) → window.__t`, avec `db` (getter/setter), `ui`, `friendExport`, `parseFriend`, `mergePro`, `importFriend`, `mergeBackup`, `priceOf`, `relCell`, `badgeFor`.

- [ ] Tests : `friendExport` inclut dans `pro` les relevés non vides seulement, triés par `at` décroissant, avec `by` = pseudo (ou le `by` d'origine) ; `seen.sales` contient les enchères `s` et `b` à prix final, non shiny, sous la forme `[card, p, t, 0, 1, auctionId]`.
- [ ] Lancer `node --test test/*.test.js` → échec (`friendExport` absent).
- [ ] Implémenter `friendExport`. `exportMine` l'utilise.
- [ ] Lancer `node --test test/*.test.js` → succès.

### Task 2 : import des relevés Pro

**Files :** Modify `wikimasters-stats.user.js` (`saveDb`, `parseFriend`, `importFriend`, nouvelle `mergePro` près de `mergeObserved`).

**Interfaces :**
- Consumes : format `pro` de la tâche 1.
- Produces : `mergePro(list, from) → number` (relevés ajoutés) ; `saveDb() → boolean` ; `parseFriend(text).pro`.

- [ ] Tests : aller-retour export → import qui remplit `db.prices` avec `by` ; date future ramenée à maintenant ; relevé local plus récent gardé ; `by === db.me` donne un relevé sans `by` ; entrées malformées ignorées ; quota dépassé : `db.prices` restauré, ami importé, message « plus assez de place ».
- [ ] Lancer → échec.
- [ ] Implémenter, puis lancer → succès.

### Task 3 : origine affichée, gardée par la sauvegarde

**Files :** Modify `priceOf`, `relCell`, `badgeFor`, `mergeBackup`.

- [ ] Tests : `priceOf(id).by` vaut le pseudo ; le `title` de `relCell` contient « relevé partagé par X » ; une ligne de `badgeFor` le contient ; `mergeBackup` garde `by`.
- [ ] Lancer → échec. Implémenter. Lancer → succès.

### Task 4 : textes et version

**Files :** `README.md` (Amis, Prix observés, Compte non Pro), le texte d'aide « Partager ma collection », les commentaires de code devenus faux, la version 1.19.0.

- [ ] `grep -n "Jamais l’historique\|jamais l'historique\|n'est jamais partagé" README.md wikimasters-stats.user.js` ne renvoie plus rien.
- [ ] `node --test test/*.test.js` → succès.
