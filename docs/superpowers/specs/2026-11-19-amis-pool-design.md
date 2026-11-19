# Amis par le pool — conception

## Pourquoi

Le pool du groupe est en ligne (`https://pool.jhemery.xyz`). Jules veut que la fonctionnalité Amis passe par lui. Plus besoin de s'échanger des fichiers : chacun retrouve automatiquement, et à jour, la collection et la liste de souhaits des autres.

Aujourd'hui, le fichier ami (`friendExport`) contient :
- la collection : `[carte, titre, rareté, exemplaires]` ;
- la liste de souhaits : `[carte, titre, rareté]` ;
- tous les prix : historique Pro, prix observés, ventes et achats.

À l'import, `db.friends[pseudo] = { at, cards: { id: [titre, rareté, exemplaires] }, wish: { id: [titre, rareté] } }` (10 amis au plus), et les prix sont fusionnés. `db.friends` sert à trois choses :
- l'onglet **Amis** : qui a quoi, l'échange équilibré (`tradeFor`), et le tableau « Tous mes amis » ;
- la colonne **« Chez un ami »** de l'onglet Souhaits ;
- l'index des titres, pour les pastilles.

Les prix passent déjà par le pool. Il ne manque que la collection et la liste de souhaits.

## Décisions de Jules

- **Visibilité : tout le groupe, au choix de chacun.** Une case à cocher, désactivée par défaut. Ceux qui la cochent apparaissent automatiquement dans l'onglet Amis de tous les autres. Pas de choix ami par ami : le pool n'a qu'une clé pour tout le groupe.
- **Approche : des profils structurés dans le pool**, et non le fichier ami déposé tel quel (qui transporterait des Mo de prix déjà présents dans le pool).

## Objectifs

- Partager, au choix, sa collection et sa liste de souhaits avec le groupe, sans fichier.
- Voir automatiquement ceux des membres qui partagent, toujours à jour, dans l'onglet Amis et dans « Chez un ami ».
- Garder les fichiers ami pour ceux qui n'utilisent pas le pool.

## Hors sujet

- Choisir ami par ami qui voit sa collection : il faudrait une identité et une clé par personne.
- Faire passer les prix par les profils : ils sont déjà dans le pool.
- Relayer les profils du pool local vers le NAS : le pool local est temporaire.

## À éviter absolument

- Publier la collection de quelqu'un qui n'a pas coché la case.
- Se voir soi-même comme ami : le compte connecté est exclu, mais un autre compte du même joueur apparaît bien.
- Qu'un ami venu du pool écrase un fichier ami plus récent, ou l'inverse sans raison.

## Approches envisagées

1. **Profils structurés (retenue par Jules).** Le serveur garde, par membre qui partage, sa collection et sa liste de souhaits, avec trois routes. C'est léger, toujours à jour, et l'onglet Amis marche tel quel.
2. **Fichier ami déposé dans le pool**, téléchargé par les autres. Le serveur serait plus simple, mais le fichier transporte tous les prix (plusieurs Mo pour un compte Pro), déjà présents dans le pool. Écartée.

## Conception

### Serveur (version 1.2.0)

Nouvelle table `profiles` :

| Colonne | Contenu |
|---|---|
| `id` | **clé primaire** : l'identifiant du compte WikiMasters |
| `pseudo` | le pseudo affiché |
| `at` | date de la publication, côté client : elle suit une relecture de la collection ou de la liste |
| `cards` | la collection, en JSON |
| `wish` | la liste de souhaits, en JSON |
| `received_at` | date de réception |

Routes, toutes avec `x-group-key` :
- `POST /v1/profile` : `{ id, pseudo, at, cards: [[carte, titre, rareté, exemplaires]…], wish: [[carte, titre, rareté]…] }`. Remplace le profil de cet `id`.
- `GET /v1/profiles` : `{ profiles: [{ id, pseudo, at, cards, wish }] }`, tous les profils.
- `POST /v1/profile/remove` : `{ id }`. Retire ce profil. C'est une route POST plutôt que DELETE, pour garder les mêmes règles CORS qu'aujourd'hui (`GET, POST, OPTIONS`).

Contrôles (`validate.js`, mêmes règles que le reste) :
- `id` sûr, 80 caractères au plus ; `pseudo` de 1 à 40 caractères ;
- `cards` : 20 000 entrées au plus ; `wish` : 5 000 au plus ;
- titre de 200 caractères au plus, rareté `[A-Z]{1,3}` ou nulle, exemplaires entiers de 1 à 9 999 ;
- tout ce qui dépasse ou ne correspond pas est refusé (400 ou 413), avec la limite de corps actuelle de 2 Mo.

Côté administration :
- `admin.js purge <membre>` retire aussi le profil de ce pseudo ;
- `poolStats` ajoute `profiles`, le nombre de profils.

Guide du serveur : la phrase « il ne reçoit jamais la collection d'un membre, ni ses souhaits » devient : il les reçoit seulement de ceux qui cochent la case, et les montre aux autres membres du groupe.

### Script (version 1.26.0)

- **Réglage** `db.pool.share` (`false` par défaut), dans le groupe « Pool partagé du groupe » : la case **« Partager ma collection et mes souhaits avec le groupe »**.
  - Elle vaut pour tous les comptes du navigateur : chaque compte publie le sien.
  - Elle demande un pseudo (`db.me`). Sans pseudo, la case renvoie vers l'onglet Amis : « Écris d'abord ton pseudo dans l'onglet Amis ».
- **Publication** `poolSendProfile()` : si `poolOn()`, `db.pool.share`, `db.userId` et `db.me` sont tous présents, elle envoie `POST /v1/profile` avec la collection (`myCards()`, comme `friendExport`) et la liste de souhaits. Elle est appelée :
  - après `ingestCollection(…, true)` et `ingestWish(…, true)`, donc par les boutons et par la mise à jour automatique ;
  - quand on coche la case.
- **Retrait** : décocher la case envoie `POST /v1/profile/remove { id: db.userId }` pour le compte connecté.
- **Réception** `poolPullProfiles()`, en même temps que `poolPullMine` (toutes les 6 h, ou tout de suite après une relecture de la collection ou de la liste) et quand on coche la case :
  - `GET /v1/profiles` ; pour chaque profil sauf celui de `db.userId` : `db.friends[nom] = { at, cards, wish, src: 'pool', id }`, au format de `parseFriend` ;
  - nom = le pseudo. Si deux membres du pool ont le même pseudo, le second devient « pseudo (2) ».
  - un ami venu d'un **fichier** portant le même nom n'est remplacé que si le profil est plus récent (`at`) ;
  - les amis `src: 'pool'` absents de la réponse (le membre a décoché ou est parti) sont retirés.
- Les amis du pool **ne comptent pas** dans la limite de 10, qui reste pour les fichiers.
- **Onglet Amis** :
  - un ami du pool est marqué « via le pool » dans la liste ;
  - « Retirer cet ami » est désactivé pour lui, avec la bulle : « Il partage sa collection par le pool : il réapparaîtrait. » ;
  - le texte d'accueil mentionne la case du pool.
- Les fichiers ami (export et import) ne changent pas.

## Tests

- **Serveur** (`test/server-db.test.js`, `test/server-http.test.js`) :
  - dépôt puis lecture d'un profil, remplacement par le même `id`, retrait ;
  - limites : 20 001 cartes donnent 413 ; un id ou une rareté invalides donnent 400 ; sans clé, 401 ;
  - `purge` retire le profil ; `stats` compte les profils.
- **Script** (`test/amis-pool.test.js`, avec le faux pool des tests du pool) :
  - case cochée et collection relue : un `POST /v1/profile` avec la collection et la liste ; case décochée : rien ;
  - décocher : `POST /v1/profile/remove` ;
  - réception : les amis `src: 'pool'` sont créés, le compte connecté est exclu, un pseudo en double devient « (2) » ;
  - un membre disparu du pool est retiré, mais un ami venu d'un fichier reste ;
  - un fichier plus récent n'est pas écrasé par un profil plus ancien ;
  - sans pseudo, rien n'est publié.

## Livraison

Script 1.26.0 et serveur 1.2.0. Après la fusion, le nouveau serveur doit être copié sur le NAS (mêmes cinq fichiers, même méthode que l'installation) et l'application `wm-pool` redémarrée. README, section Amis, et guide : la case et ce qu'elle partage.

## Décisions prises par Claude (à vérifier)

- **Identité = le compte WikiMasters (`db.userId`), pseudo affiché à part** : deux pseudos identiques ne se confondent pas, et ton autre compte apparaît comme un ami.
- **La case vaut pour tous les comptes du navigateur**, comme le reste des réglages du pool.
- **Pas de limite de 10 pour les amis du pool.**
- **Les profils ne sont pas relayés du pool local vers le NAS.**
- **Le retrait se fait par une route POST**, pour ne pas toucher aux règles CORS.
- **N'importe quel membre qui a la clé pourrait déposer un profil sous un autre id, ou en retirer un.** C'est acceptable entre amis, comme le reste du pool, qui repose sur la confiance dans le groupe.
