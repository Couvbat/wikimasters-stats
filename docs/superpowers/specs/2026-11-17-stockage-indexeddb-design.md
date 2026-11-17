# Stockage dans IndexedDB — conception (approuvée par Jules)

## Pourquoi

Le script range tout dans le `localStorage` du site, limité à environ 5 Mo (5 242 880 caractères) par site. Le compte Pro de Jules, dans Zen, y est arrivé pile :

| Partie | Champ | Caractères |
|---|---|---|
| commune (`wmstats.v1`) | `prices` | 1 412 338 |
| | `obsSales` | 699 908 |
| | `finQ` | 301 731 |
| | `obs` | 273 610 |
| personnelle (`wmstats.v1.u.<compte>`) | `cards` | 2 185 426 |
| | `friends`, `pulls`, `alerts`… | moins de 100 000 chacun |

Les replis de `saveDb` (relevé du marché retiré, historique ramené à 10 ventes par rareté) ne suffisent plus. L'en-tête affiche « ⚠ Navigateur plein », et tout ce que fait Jules dans Zen est perdu au rechargement. Les données grossissent normalement : collection, historique Pro, prix observés par la collecte automatique.

Le verrou de la collecte automatique (`wmstats.auto`) vit lui aussi dans le `localStorage`. Quand celui-ci est plein, il échoue en silence.

## Objectifs

- Plus de limite de 5 Mo : les données du script vont dans IndexedDB. Firefox, Zen et Chrome y permettent des centaines de Mo par site.
- **Aucune perte** au passage : la copie depuis le `localStorage` est vérifiée avant que l'ancienne soit effacée.
- Le reste du script ne change pas : même objet `db` en mémoire, même découpage (une partie commune, une partie par compte), mêmes fonctions qui appellent `saveDb()`.
- Le `localStorage` libéré redonne sa place au verrou `wmstats.auto` et au site.

## Hors sujet

- Relever les plafonds (60 ventes par carte, 4 000 annonces, 6 000 enchères suivies). Ce serait une décision à part, maintenant possible.
- Enregistrer seulement ce qui a changé (une écriture par champ). On réécrit tout, comme aujourd'hui.
- Demander au navigateur un stockage « persistant » (`navigator.storage.persist()`) : Firefox afficherait une demande au nom du site.
- Le pool, la sauvegarde (export et import) et le fichier ami : inchangés.

## À éviter absolument

- Écrire dans la base avant d'avoir chargé ce qu'elle contient. Ce serait remplacer les données de Jules par un `db` vide.
- Effacer le `localStorage` sans avoir relu et comparé la copie dans IndexedDB.
- Faire attendre le site : l'interception des requêtes doit rester posée dès `document-start`.

## Approches envisagées

1. **IndexedDB, même modèle en mémoire, réécriture complète (retenue par Jules).** C'est le stockage prévu pour de gros volumes dans une page, sans dépendance. On garde toute la logique actuelle ; seule la couche d'enregistrement change. Il est asynchrone, donc il faut attendre le chargement au démarrage.
2. **Format compact dans le `localStorage`** (ventes en tableaux courts, dates raccourcies). Environ 40 % de place en moins, mais le plafond reviendrait avec la croissance des données. Écartée.
3. **Stockage de Tampermonkey (`GM_setValue`).** Il demande des `@grant`, ce qui sort le script du contexte de la page. Il faudrait alors poser le hook de `fetch` via `unsafeWindow`, avec les difficultés propres à Firefox. Lourd, et sans gain sur IndexedDB. Écartée.

## Conception

### La base

- Base IndexedDB `wmstats`, version 1, un seul magasin `kv` (clés fournies à l'écriture).
- Enregistrements, sous **les mêmes clés qu'aujourd'hui** dans le `localStorage` (choix fait au plan : la copie est clé pour clé, et `readJson(KEY)` ou `acctKey(uid)` ne changent pas) :
  - `wmstats.v1` : la partie commune ;
  - `wmstats.v1.u.<compte>` : la partie personnelle d'un compte (`wmstats.v1.u._` tant que le compte n'est pas reconnu).
- Valeur : **le texte JSON**, exactement celui que `splitDb` + `JSON.stringify` produisent aujourd'hui pour le `localStorage`. La migration est alors une copie à l'identique, vérifiable par égalité de texte, et la lecture passe par le même `JSON.parse`.
- `onversionchange` ferme la connexion, pour qu'une future version 2 de la base ne reste pas bloquée par un onglet ouvert.

### Le cache en mémoire

Une couche `store` garde en mémoire le dernier texte connu de chaque enregistrement. Elle est remplie au chargement, puis mise à jour à chaque enregistrement.

- `loadDb()` reste **synchrone** : elle reconstruit `db` à partir de ce cache, comme elle le fait aujourd'hui à partir du `localStorage`. Les appels existants (`db = loadDb()` après un import raté, rechargement depuis un autre onglet) ne changent pas.
- `setAccount(uid)` lit la partie personnelle de l'autre compte dans ce cache, toujours de façon synchrone.
- La ligne des comptes (Réglages) compte les enregistrements `wmstats.v1.u.…` du cache, sans `wmstats.v1.u._`.

### Démarrage

1. Le hook de `fetch` est posé tout de suite, comme aujourd'hui.
2. `ready` est une promesse résolue quand les données sont chargées.
   - **Sans IndexedDB** (absent, ou ouverture en erreur) : lecture synchrone du `localStorage` comme aujourd'hui, et `ready` est déjà résolue. C'est le mode « secours ».
   - **Avec IndexedDB** : ouverture et lecture de tous les enregistrements, migration si besoin (plus bas), puis `db = loadDb()`.
3. Tant que les données ne sont pas chargées :
   - les réponses du site interceptées attendent `ready` avant leur `ingest…`. On utilise un petit `whenReady(f)` qui appelle `f()` tout de suite si c'est déjà chargé, et sinon `ready.then(f)` ;
   - `start()` (montage du panneau, pastilles) attend aussi `ready` ;
   - les minuteurs (`minuteTick`, collecte automatique, pool) ne font rien ;
   - `saveDb()` ne fait **rien** et renvoie `true`.

### Migration

Au chargement avec IndexedDB :

- **La base contient `wmstats.v1`** : elle fait foi. S'il reste des clés `wmstats.v1*` dans le `localStorage` (effacement raté, ou ancienne version du script relancée entre-temps), elles sont effacées. `wmstats.auto` n'est jamais touché.
- **La base est vide et le `localStorage` contient `wmstats.v1`** :
  1. Lire les textes bruts de `wmstats.v1` et de toutes les clés `wmstats.v1.u.*`.
  2. Les écrire tels quels, sous les mêmes clés, dans **une seule** transaction.
  3. Une fois la transaction terminée, tout relire et comparer chaque texte au texte d'origine.
  4. Si tout est identique, effacer ces clés du `localStorage`. Sinon, ne rien effacer et passer en mode secours pour cette visite.
- **Rien nulle part** : on part de `defaults()`.

L'ancien format d'avant la 1.20 (tout sous `wmstats.v1`) est copié tel quel. `loadDb` sait déjà le lire, et le premier enregistrement le répartit.

### Enregistrement

- `saveDb()` prend tout de suite un instantané : `splitDb()` + `JSON.stringify`, comme aujourd'hui. Il le range dans les écritures en attente : `wmstats.v1`, plus `wmstats.v1.u.<compte>` pour le compte **au moment de l'appel**. C'est indispensable pour `setAccount`, qui enregistre l'ancien compte puis change `db.userId` aussitôt. Il met à jour le cache, puis renvoie `true`.
- Une seule transaction IndexedDB à la fois. Elle écrit toutes les écritures en attente ; s'il en arrive d'autres pendant ce temps, une nouvelle transaction part dès la fin de la précédente. Plusieurs `saveDb()` dans la même tâche donnent une seule transaction.
- Écriture réussie : `saveState.failed = 0`, puis on prévient les autres onglets.
- Erreur ou abandon de la transaction (disque plein…) : `saveState.failed = Date.now()`, ce qui affiche l'avertissement actuel de l'en-tête. Les écritures restent en attente et repartent au prochain `saveDb()`.
- En mode secours, `saveDb` garde exactement son comportement actuel (replis du `localStorage`, retour `false` possible).
- `setAccount` efface `wmstats.v1.u._` de la base (et du cache), là où il l'efface aujourd'hui du `localStorage`.

### Plusieurs onglets

- `BroadcastChannel('wmstats')` : après chaque écriture réussie, on poste `{ saved: <onglet> }`.
- Un onglet qui reçoit ce message, si aucun traitement n'est en cours (`!job.running`, comme aujourd'hui), relit la base, met le cache à jour, puis fait `db = loadDb()` et `refresh()`.
- En mode secours, l'écoute de l'événement `storage` reste celle d'aujourd'hui.

### Onglet Sauvegarde

Une ligne de plus : « Rangées dans IndexedDB : 4,3 Mo » (somme des textes du cache), ou « Rangées dans le stockage du site (limité à 5 Mo) » en mode secours. Elle permet à Jules de vérifier que le passage a eu lieu.

## Tests

- `test/harness.js` fournit un faux `indexedDB` minimal en mémoire, seulement quand un test le demande (`load({ idb: … })`) : `open` avec `onupgradeneeded` et `onsuccess`, `transaction`, `objectStore`, `get`, `put`, `delete`, `getAllKeys`, `oncomplete` et `onerror`. Il doit pouvoir simuler une erreur d'écriture. `load` renvoie la promesse `ready`.
- Sans `idb`, aucun `indexedDB` n'est présent : le script passe en mode secours, et **les 123 tests existants passent sans changement**.
- Nouveaux tests :
  - migration de deux comptes depuis le `localStorage` ;
  - migration de l'ancien format d'avant la 1.20 ;
  - relecture qui ne correspond pas : rien n'est effacé, mode secours ;
  - base déjà remplie : elle fait foi, et les clés restantes sont effacées ;
  - `saveDb` avant le chargement : rien n'est écrit ;
  - instantané par compte au changement de compte ;
  - regroupement de plusieurs `saveDb` en une transaction ;
  - erreur d'écriture : avertissement, puis nouvel essai ;
  - message d'un autre onglet : rechargement.

## Livraison

Version 1.24.0. Une entrée dans le README : où sont rangées les données, et comment le vérifier (onglet Sauvegarde).

## Décisions prises par Claude (à vérifier)

- **Texte JSON plutôt qu'objets.** La copie est à l'identique et la vérification se fait par égalité de texte ; même coût que l'enregistrement d'aujourd'hui.
- **Le `localStorage` est effacé après une copie vérifiée.** C'est ce qui libère la place du verrou `wmstats.auto`. Ton export de l'onglet Sauvegarde reste un filet en plus.
- **La base fait foi si elle existe déjà.**
  - Cas limite 1 : un onglet resté ouvert sur l'**ancienne** version pendant la mise à jour continue d'écrire dans le `localStorage`. Ce qu'il a fait depuis le passage d'un autre onglet est perdu au rechargement suivant.
  - Cas limite 2 : revenir à une version antérieure à la 1.24 repart du `localStorage`, vide. Les données restent dans IndexedDB et reviennent avec la 1.24.
  - Pour éviter le premier cas : recharger tous les onglets du site après la mise à jour.
- **Pas d'attente maximale à l'ouverture de la base.** Avec une seule version de schéma et `onversionchange`, elle ne peut pas rester bloquée. Une erreur d'ouverture fait passer en mode secours.
- **Le verrou `wmstats.auto` reste dans le `localStorage`.** Il est petit, et son fonctionnement entre onglets repose sur une lecture synchrone.
