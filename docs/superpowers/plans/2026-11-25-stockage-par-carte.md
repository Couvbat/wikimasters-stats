# Données rangées carte par carte — plan d'implémentation

> **Pour les agents :** sous-compétence requise : superpowers:executing-plans (exécution en ligne, choisie : Jules a dit « go »). Les étapes se suivent avec des cases (`- [ ]`).

**But :** en mode IndexedDB, ranger chaque carte de `prices`, `obsSales` et `hist` dans sa propre entrée, pour qu'un enregistrement n'écrive que ce qui a changé et puisse repartir tout de suite (script 1.32.0).

**Architecture :** tout se passe dans la couche de stockage de `wikimasters-stats.user.js` :
- `loadDb` reconstruit les trois sections à partir des entrées ;
- `saveNow` écrit les cartes dont la signature a changé, puis `wmstats.v1` (sans les trois sections) et la partie personnelle ;
- la file `store.pending` et `flushStore` restent la seule voie vers IndexedDB.

Le mode localStorage ne change pas.

**Technique :** JavaScript sans dépendance (userscript `@grant none`), tests `node:test` avec le faux IndexedDB de `test/harness.js`.

**Spec :** `docs/superpowers/specs/2026-11-25-stockage-par-carte-design.md`

## Contraintes générales

- Clés : `wmstats.v1.p.<carte>` (prices), `wmstats.v1.o.<carte>` (obsSales), `wmstats.v1.h.<carte>` (hist). `wmstats.v1` garde `prices`, `obsSales` et `hist` sous forme de `{}`.
- Fusion au chargement :
  - obsSales : `keepAll` de l'union ;
  - prices : le plus récent (`at`), avec `keepAll` de l'union des ventes ;
  - hist : le plus récent (`at`).
- Filet de sécurité toutes les 10 minutes. Reconstruction de `db` depuis un autre onglet sans relire toute la base.
- Mode localStorage, partie personnelle, `db` en mémoire, sauvegardes exportées et pool : inchangés.
- Version 1.32.0 (`@version` et repli de `VERSION`). README, section Sauvegarde.
- Commits en français, terminés par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Points à surveiller (non couverts ailleurs, chacun a son test dans la tâche indiquée)

1. Une entrée illisible (JSON abîmé) ne doit pas empêcher le chargement : elle est ignorée (tâche 1).
2. Des entrées par carte sans `wmstats.v1` (base vidée en partie) : le chargement garde les cartes (tâche 1).
3. Un identifiant de carte qui contient un point : la clé se relit par son préfixe, pas en coupant aux points (tâche 1).
4. Un onglet resté sur une version d'avant la 1.32 réécrit les trois sections dans `wmstats.v1` : rien n'est perdu (tâche 2).
5. Deux onglets qui changent chacun une carte différente au même moment : les deux restent (tâche 3).

---

### Tâche 1 : entrées par carte (enregistrement, chargement, effacement)

**Fichiers :** `wikimasters-stats.user.js` (couche de stockage, lignes 140 à 420 environ), `test/harness.js` (le faux IndexedDB compte les écritures par clé), test : `test/stockage-cartes.test.js` (nouveau).

**Interfaces :**
- Produit :
  - `CARD_SECS = [['p', 'prices'], ['o', 'obsSales'], ['h', 'hist']]` ;
  - `cardKey(s, id) → string` ;
  - `cardSig(s, v) → Array` ;
  - `written : Map<clé, signature>` (la dernière écriture ou lecture de chaque entrée) ;
  - `saveCards() → void` (pose dans `store.pending` les cartes changées et les effacements) ;
  - `store.set` ne fait rien quand le texte est identique à celui en cache.
- Harnais : `idbStats.puts` (clés écrites, dans l'ordre) et `idbStats.reads` (nombre de `getAll`).

- [ ] **Étape 1 : tests qui échouent** dans `test/stockage-cartes.test.js` :
  - `chaque carte a son entrée ; wmstats.v1 n'a plus les ventes` : `prices.C1`, `obsSales.C2` et `hist.C3` posés, puis `saveDb` et `await store.idle()`. Résultat attendu :
    - `idbData` a `wmstats.v1.p.C1`, `.o.C2` et `.h.C3` (JSON égal à `db`) ;
    - `JSON.parse(idbData.get('wmstats.v1'))` a `prices`, `obsSales` et `hist` à `{}`.
  - `une seule carte changée : seule son entrée est écrite` : après un premier enregistrement, `obsSales.C2` est remplacée. Attendu : `idbStats.puts` depuis = `['wmstats.v1.o.C2']`.
  - `une carte retirée : son entrée est effacée` : `delete db.obsSales.C2`, enregistrement. Attendu : `idbData.has('wmstats.v1.o.C2') === false`.
  - `rechargement : les mêmes cartes, une entrée abîmée ignorée, un identifiant à point relu entier` : `idbData` est partagé entre deux `load`. Une entrée `wmstats.v1.o.X` vaut `'{abîmé'` et une carte s'appelle `A.B`. Le second `load` a `obsSales['A.B']` et pas `X`, et ne plante pas.
  - `des entrées sans wmstats.v1 : les cartes sont gardées`.
  - `mode localStorage : une seule clé, comme avant` : sans `idb`, `saveDb()`. Le texte de `wmstats.v1` contient `prices.C1`, et aucune clé `.p.` n'existe.
- [ ] **Étape 2 :** `node --test test/stockage-cartes.test.js`. Attendu : échec (pas d'entrées `.p.`, `.o.` ni `.h.`).
- [ ] **Étape 3 : code.**
  - `saveNow` (mode `idb`) appelle `saveCards()` puis écrit `wmstats.v1` et la partie personnelle. En mode `idb`, `splitDb` met les trois sections à `{}`.
  - `loadDb` (mode `idb`) parcourt `store.texts` par préfixe, lit chaque entrée dans un `try` et remplit `written` avec la signature lue.
  - `cardSig` :
    - `o` : `[liste, longueur]` ;
    - `p` : `[objet, ventes, longueur, at, by, ats]` ;
    - `h` : `[objet]`.
  - Effacement : une clé de `written` qui n'a plus de carte devient `store.del` et sort de `written`.
- [ ] **Étape 4 :** le fichier de test, puis toute la suite. Attendu : tout vert. Si des tests de la 1.31 attendent l'ancien format de `wmstats.v1`, les adapter et le dire dans le commit.
- [ ] **Étape 5 :** commit « Stockage par carte : une entrée IndexedDB par carte (prices, obsSales, hist) ».

### Tâche 2 : passage au nouveau rangement et fusion

**Fichiers :** `wikimasters-stats.user.js` (`loadDb`), `test/stockage-cartes.test.js`.

**Interfaces :**
- Consomme : `CARD_SECS`, `cardKey`, `cardSig`, `written` (tâche 1).
- Produit : `mergeCard(s, a, b) → valeur fusionnée`, avec les règles des contraintes générales.

- [ ] **Étape 1 : tests qui échouent :**
  - `une base d'avant la 1.32 passe aux entrées par carte` : `wmstats.v1` avec les trois sections pleines. Après chargement, `db` a les cartes. Après enregistrement, les entrées existent et les sections de `wmstats.v1` sont `{}`.
  - `un onglet d'avant la 1.32 a réécrit wmstats.v1 : fusion sans perte` : les entrées existent, et `wmstats.v1` a aussi les cartes suivantes.
    - `obsSales.C2` avec une vente en plus. Attendu : union, 2 ventes.
    - `prices.C1` avec un `at` plus ancien et une autre vente. Attendu : `at` le plus récent, ventes réunies.
    - `hist.C3` plus récent. Attendu : celui-là.
- [ ] **Étape 2 :** lancer, voir l'échec (la section de `wmstats.v1` écrase ou ignore l'entrée).
- [ ] **Étape 3 :** dans `loadDb`, les sections venues de `wmstats.v1` sont fusionnées avec les entrées (`mergeCard`). Une carte fusionnée ou venue seulement de `wmstats.v1` n'entre pas dans `written`, pour être écrite au prochain enregistrement.
- [ ] **Étape 4 :** fichier puis suite : vert.
- [ ] **Étape 5 :** commit.

### Tâche 3 : enregistrement immédiat, filet de sécurité, autres onglets

**Fichiers :** `wikimasters-stats.user.js` (`saveDb`, `minuteTick`, `flushStore`, `channel.onmessage`), `test/stockage-cartes.test.js`, `test/economies.test.js` (tests de la 1.31 à revoir).

**Interfaces :**
- Consomme : `saveCards`, `written`, `cardSig` (tâche 1).
- Produit :
  - `checkCards() → nombre d'entrées réécrites` ;
  - le message `{ saved: TAB, keys: [clé…] }` ;
  - `loadDb(keepCards)` : avec `keepCards`, garde les trois sections du `db` courant au lieu de tout relire.

- [ ] **Étape 1 : tests qui échouent :**
  - `enregistrement immédiat : écrit au tour suivant, sans attendre 5 s ; plusieurs saveDb dans la même tâche, une écriture`.
  - `filet de sécurité : une liste changée sur place sans changer de longueur est écrite dans les 10 minutes` : horloge simulée. `obsSales.C2[0].p` est changé sur place, et `saveDb` n'écrit rien. 11 minutes plus tard, `minuteTick()` écrit `.o.C2`.
  - `deux onglets : A change C1, B change C2, les deux restent ; B reçoit C1 sans relire toute la base` : `idbStats.reads` n'augmente pas.
  - Tests de la 1.31 dans `test/economies.test.js` :
    - « une seule écriture par rafale » devient « une écriture par tâche » ;
    - « onglet caché ou quitté » ne vérifie plus d'attente ;
    - « un autre onglet ne fait pas perdre un enregistrement en attente » est remplacé par le test des deux onglets ci-dessus. Il n'y a plus d'attente, et `wmstats.v1` reste au dernier qui écrit, comme avant la 1.31.
- [ ] **Étape 2 :** lancer, voir l'échec.
- [ ] **Étape 3 : code.**
  - `saveDb` (mode `idb`) regroupe par microtâche. Il n'y a plus de `SAVE_EVERY`.
  - `checkCards` est appelé depuis `minuteTick` quand 10 minutes sont passées depuis le dernier passage.
  - `flushStore` envoie les clés écrites.
  - À la réception d'un message avec `keys` :
    - lire seulement ces clés (une transaction de `get`) et mettre à jour `store.texts`, sauf les clés en attente ici ;
    - pour une carte que cet onglet n'a pas changée depuis sa dernière écriture (signature de `db` égale à celle de `written`), la poser dans `db` et dans `written` ;
    - si `wmstats.v1` ou la partie personnelle de ce compte en font partie et que `mayReload()`, faire `db = loadDb(db)`, au plus une fois par seconde ;
    - puis `resetPrices` et `refresh`.
  - Un message sans `keys` (onglet d'avant la 1.32) garde le comportement actuel.
- [ ] **Étape 4 :** fichier, `test/economies.test.js`, puis suite : vert.
- [ ] **Étape 5 :** commit.

### Tâche 4 : mesures, vrai navigateur, README, version

**Fichiers :** `wikimasters-stats.user.js` (version 1.32.0), `README.md` (Sauvegarde), banc d'essai du dossier de travail (hors dépôt).

- [ ] **Étape 1 :** banc d'essai `job.js` (30 cartes, rythme réel, 24 800 cartes × 8 ventes), branche contre `main`. Attendu : moins de 10 ms de processeur par carte, et de l'ordre de quelques Ko écrits par carte au lieu de 13 Mo par écriture.
- [ ] **Étape 2 :** vrai navigateur (Chromium, page locale, vrai IndexedDB, environ 27 000 entrées). Attendu :
  - le chargement et le passage au nouveau rangement marchent sans erreur ;
  - un enregistrement n'écrit que la carte changée ;
  - le temps de chargement est noté.
- [ ] **Étape 3 :** version 1.32.0 et README : entrées par carte, enregistrement de nouveau immédiat, ce qui reste (ce qui est écrit au moment où la page se ferme peut se perdre, mais il n'y a plus d'attente de 5 s), ne pas revenir en dessous de 1.32 (sinon les ventes ne s'affichent plus, sans être perdues).
- [ ] **Étape 4 :** suite complète : vert. Commit, relecture de toute la branche, puis poussée et PR.
