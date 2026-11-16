# Pool de prix partagé du groupe — conception

## Pourquoi

Jules veut que tous les prix croisés par n'importe quel membre de son groupe de potes servent à tout le groupe, automatiquement, Pro et non-Pro mélangés. Le partage par fichier (v1.19) marche, mais il est manuel et dans un seul sens. Une base commune, hébergée chez Jules, doit :
- **remplir au mieux les tableaux de chacun**, même sans compte Pro ;
- **garder tout l'historique**, pour de meilleures stats (pas de limite à 10 ventes ni d'expiration de 24 h comme en local) ;
- **faire moins de requêtes au site** : ce qu'un membre a déjà relevé, les autres ne le redemandent pas.

## Objectifs

- Envoi automatique de tout prix relevé localement : historique Pro, prix finaux exacts, prix provisoires, ventes et achats personnels.
- Réception automatique des prix du groupe pour les cartes qui comptent pour chacun : collection, liste de souhaits, cartes affichées sur le site.
- Éviter au site les relectures inutiles :
  - prix finaux déjà connus du pool, sautés par « Relever les prix finaux » (manuel ou automatique) ;
  - historiques Pro frais (moins de 24 h), sautés par les relevés Pro.
- Conservation illimitée côté serveur.

## Non-objectifs (phase 1)

- Le partage des **annonces en cours** : c'est la phase 2, esquissée à la fin, avec un plan à part.
- Les comptes individuels, l'interface web d'administration, les statistiques côté serveur au-delà d'un compteur.

## Anti-objectifs (échec même si ça « marche »)

- Le pool change la façon dont le script parle au site. Côté site, il reste en lecture seule, au même rythme.
- La clé du groupe ou l'URL du pool se retrouve dans le code source public, dans un fichier ami ou dans une sauvegarde.
- Une panne du pool (fibre de Jules coupée, NAS éteint) casse ou ralentit l'extension.
- Le pool augmente le nombre de requêtes envoyées au site.

## Contraintes

- **Le script est public** (GitHub, mise à jour automatique) : aucun secret dedans. Chaque membre saisit l'URL et la clé dans ses Réglages.
- **La Data API de MongoDB Atlas n'existe plus** (fin de vie le 30/09/2025) : un serveur est de toute façon nécessaire. Choix fait : auto-hébergé.
- **Hébergement** : le NAS TrueNAS « optimus » de Jules, derrière sa connexion domestique. Le pool n'est joignable que quand cette connexion fonctionne.
- **Appels depuis la page du site** : le script tourne dans la page (`@grant none`, `@inject-into page`). Ses appels au pool sont donc des requêtes cross-origin depuis `https://www.wiki-masters.com`, et le serveur doit répondre aux en-têtes CORS. Un `fetch` vers `raw.githubusercontent.com` a fonctionné depuis la page le 16/11 : la CSP du site ne semble pas restreindre `connect-src`. À revérifier avec l'URL finale.
- **Le pool doit être en HTTPS** : une page HTTPS ne peut pas appeler une adresse HTTP du réseau local (contenu mixte).
- **Le `localStorage` est limité** (environ 5 Mo, partagé avec le site) : le client ne recopie pas tout le pool, seulement ce qui sert. Les plafonds locaux restent : 10 ventes par carte, 8000 cartes observées.
- **La limite d'automatisation du site** (`automation_limit`) reste gérée comme en v1.19 ; le pool ne fait que réduire les requêtes.

## Approches envisagées

**Hébergement**
- *Serverless + base gérée* (Cloudflare Worker, base gratuite) : rien à maintenir, toujours en ligne, mais les données vivent chez un tiers. Non retenu.
- *Auto-hébergé sur optimus* : données chez Jules, contrôle total ; disponibilité liée à sa connexion. **Choisi par Jules.**

**Moteur de base**
- *MongoDB* : connu de Jules, mais un conteneur de plus à gérer, sans gain à cette échelle.
- *SQLite* : un fichier sur un dataset, zéro administration, sauvegarde par instantané ZFS. **Choisi par Jules.**

## Architecture

```
navigateur (script)  --HTTPS-->  tunnel  -->  optimus : conteneur node:24 (server/) --> /data/pool.db (SQLite)
```

### Serveur (`server/` dans ce dépôt)

- Node 24, **zéro dépendance** : `node:http`, `node:sqlite`, `node:crypto`, et `node:test` pour les tests.
- Un seul processus, configuré par variables d'environnement :
  - `GROUP_KEY` : au moins 24 caractères, obligatoire ;
  - `DB_PATH` : par défaut `/data/pool.db` ;
  - `PORT` : par défaut `8787` ;
  - `ALLOWED_ORIGINS` : par défaut `https://www.wiki-masters.com,https://wiki-masters.com`.
- SQLite en mode WAL.

**Schéma**

```sql
CREATE TABLE sales (
  id INTEGER PRIMARY KEY,
  card TEXT NOT NULL,          -- identifiant de la carte
  price INTEGER NOT NULL,      -- wikibidous, > 0
  sold_at TEXT NOT NULL,       -- date ISO de la vente
  kind TEXT NOT NULL,          -- 'pro' (historique Pro) | 'exact' (prix final lu) | 'prov' (dernière offre vue)
  auction TEXT,                -- identifiant d'enchère quand connu
  gap INTEGER NOT NULL DEFAULT 0, -- minutes entre l'observation et la fin (prix provisoires)
  rarity TEXT,                 -- rareté au moment de la vente, si connue
  member TEXT,                 -- pseudo du membre qui l'a envoyée
  received_at INTEGER NOT NULL -- ms
);
CREATE INDEX sales_card ON sales(card, sold_at DESC);
CREATE UNIQUE INDEX sales_auction ON sales(auction) WHERE auction IS NOT NULL;
CREATE TABLE pro_fetch (card TEXT PRIMARY KEY, at INTEGER NOT NULL, member TEXT); -- dernier relevé Pro de la carte
```

**Règles de fusion** (dans une transaction, pour chaque vente reçue)
1. Si l'enchère est connue et déjà en base : on remplace un `prov` par une vente finale (`exact` ou `pro`). Sinon, rien ne change.
2. Sinon, une vente de même `(card, sold_at, price)` est un doublon : un `prov` est remplacé par une vente finale, sinon rien ne change. Cette règle attrape la même vente reçue une fois par l'historique Pro (sans enchère) et une fois comme prix final (avec enchère).
3. Sinon, la vente est insérée.
4. Liste `unsold` (enchères finies sans vente) : la ligne `prov` de cette enchère est supprimée.
5. `pro_fetch` : on garde le relevé le plus récent. Une date future est ramenée à maintenant.

Rien n'est jamais supprimé, sauf les `prov` invendus et une purge manuelle par membre (commande d'administration, voir plus bas).

**Routes** (JSON ; toutes demandent `X-Group-Key`, sauf `/v1/health`)

| Route | Corps | Réponse |
|---|---|---|
| `GET /v1/health` | — | `{ ok, version }` |
| `GET /v1/stats` | — | `{ sales, cards, members, lastPushAt }` |
| `POST /v1/push` | `{ member, pro: [[card, at, [[p, t], …], rarity?], …], sales: [[card, p, t, g, x, auctionId, rarity?], …], unsold: [auctionId, …] }` | `{ added, upgraded, dropped }` |
| `POST /v1/pull` | `{ cards: [id, …] }` (500 au plus) | `{ cards: { id: { pro: { at, by, sales: [[p, t], …] } \| null, sales: [[p, t, g, x, auctionId], …] } } }` (10 dernières de chaque) |
| `POST /v1/known` | `{ auctions: [id, …] }` (1000 au plus) | `{ exact: { auctionId: [card, p, t] } }` |

Précisions :
- Les formats `pro` et `sales` reprennent ceux du fichier ami v1.19, plus la rareté. Le client réutilise donc `proExport`, `observedExport`, `mergePro` et `mergeObserved`.
- Dans `sales`, `x = 1` indique une vente finale (`exact`) et `x = 0` un prix provisoire (`prov`).
- Les entrées `pro` deviennent des lignes `kind = 'pro'`, et `at` met à jour `pro_fetch`.

**Validation et protections**
- Validation identique au client : identifiants sûrs, au plus 80 caractères, pas de `__proto__` ; prix entiers positifs ; dates lisibles ; dates futures ramenées à maintenant.
- Plafonds : corps de 2 Mo, 2000 entrées `pro`, 5000 `sales`, 5000 `unsold` par envoi.
- Clé comparée en temps constant (`crypto.timingSafeEqual`) : mauvaise clé, réponse 401. La clé n'est jamais journalisée.
- Limite de débit par adresse IP du membre : 120 requêtes par minute. Au-delà, réponse 429 avec `Retry-After`. Derrière un tunnel, toutes les requêtes arrivent de l'adresse du tunnel : l'adresse vient donc de `CF-Connecting-IP` (Cloudflare), sinon du premier `X-Forwarded-For` (Tailscale), sinon de la connexion. Sans ça, tout le groupe partagerait une seule limite.
- CORS :
  - origines `ALLOWED_ORIGINS`, en-têtes `content-type` et `x-group-key`, méthodes `GET`, `POST` et `OPTIONS` ;
  - réponse au pré-vol mise en cache (`Access-Control-Max-Age: 600`), avec `Access-Control-Allow-Private-Network: true` pour les tests depuis `localhost`.
- Administration en ligne de commande dans le conteneur : `node server/admin.js purge <membre>` et `node server/admin.js stats`.

### Client (le script)

**Réglages** : nouveau groupe « Pool partagé du groupe (tous comptes) » :
- les champs URL et clé (champ mot de passe) ;
- la case « Partager et recevoir les prix » (désactivée par défaut) ;
- le bouton « Tester », qui appelle `/v1/stats` et affiche « Connecté : N ventes, M cartes, K membres » ;
- une ligne d'état : dernier envoi, dernière réception, compteurs, dernière erreur.

Ces données sont rangées dans `db.pool = { url, key, on, ... }`. **`db.pool` est exclu de `exportBackup` et du fichier ami.** Risque accepté : comme toutes les données du script, la clé est dans le `localStorage` du site, que le site pourrait lire.

**Envoi**
- File `db.poolQ`, enregistrée pour survivre à un rechargement, plafonnée à 20 000 entrées (les plus anciennes sautent).
- Seules les données **relevées localement** y entrent :

  | Point d'accroche | Entrée envoyée |
  |---|---|
  | `ingestSales` (relevé Pro non vide) | entrée `pro` |
  | `settleObserved`, quand un prix provisoire est créé | entrée `sales` avec `x = 0` |
  | `ingestFinal`, prix final | entrée `sales` avec `x = 1` |
  | `ingestFinal`, enchère invendue | entrée `unsold` |
  | `tidyAuctions` / `recordAuction`, ventes et achats personnels non shiny à prix final | entrée `sales` avec `x = 1` |

- L'ajout à la file se fait à ces points d'accroche, **pas dans `addObserved`, `mergePro` ni `mergeObserved`** : ce qui vient du pool, d'un fichier ami ou d'une sauvegarde n'est jamais renvoyé.
- Envoi toutes les 15 s si la file n'est pas vide, par lots dans les plafonds du serveur. En cas d'échec, la file est gardée et le délai double (1 min, puis 2, 4… jusqu'à 30 min). `member` vaut `db.me` (le pseudo de l'onglet Amis), ou « anonyme » si vide.

**Réception**
- **Collection et souhaits** : au plus une fois toutes les 6 h (et à la demande via « Tester »), une réception de toutes les cartes de la collection et des souhaits, par lots de 500.
- **Cartes vues sur le site** (pastilles) : les cartes sans aucun prix local, regroupées après 2 s, 500 au plus par appel, chaque carte une seule fois par visite.
- **Fusion** :
  - `pro` passe par `mergePro`, avec `by` égal au membre (« relevé partagé par X », comme en v1.19) ;
  - `sales` passe par `mergeObserved`.

**Moins de requêtes au site**
- Avant « Relever les prix finaux » (manuel et automatique) : appel à `/v1/known` avec les enchères en attente (`finQ`). Les prix déjà connus sont fusionnés et ces enchères sortent de la file : seules les autres sont lues sur le site.
- Relevés Pro (« Compléter les prix manquants », Mes enchères, boosters) : on reçoit d'abord les cartes du lot. Un relevé Pro du pool de moins de 24 h rend `priceStale` faux, et la carte est sautée naturellement.

**Panne du pool**
- Toute erreur du pool met à jour la ligne d'état, sans jamais bloquer l'interface ni ralentir les relevés.
- Pool désactivé ou mal configuré : le script se comporte exactement comme la v1.19.

### Déploiement sur optimus

- **TrueNAS 25.10** sur optimus (constaté le 16/11 : la page publique `/api/versions` va jusqu'à `v25.10.5`). Ce sont des applications Docker, avec « Custom App » installée par YAML. Interface sur le réseau local : `https://192.168.1.70:4443`.
- **Dataset `apps/wm-pool`**, avec deux sous-dossiers :
  - `app/` : les fichiers de `server/` copiés tels quels ;
  - `data/` : la base SQLite.
- **Application** : l'image officielle `node:24-alpine` et `command: node /app/server.js`. Le code est monté depuis le dataset : **pas d'image à construire ni de registre**. Mise à jour = copier les nouveaux fichiers, puis redémarrer l'application.
- **Accès HTTPS depuis Internet : Cloudflare Tunnel** (Jules a un domaine géré par Cloudflare).
  - Un service `cloudflared` dans le même YAML que le serveur (`cloudflare/cloudflared`, commande `tunnel run`, variable `TUNNEL_TOKEN`). Aucun port n'est ouvert sur la box.
  - À faire une fois par Jules dans son compte Cloudflare (Zero Trust → Networks → Tunnels) :
    1. créer le tunnel et récupérer son jeton ;
    2. ajouter un nom public, par exemple `pool.<son domaine>`, qui pointe vers `http://wm-pool:8787`.
  - Les membres saisissent `https://pool.<son domaine>` dans leurs Réglages. Cloudflare transmet l'adresse réelle de chaque membre dans `CF-Connecting-IP`, ce que la limite de débit utilise.
- **Sauvegardes** : instantanés périodiques ZFS du dataset (tâche TrueNAS).
- Un `docker-compose.yml` d'exemple et un guide pas à pas (`server/README.md`) sont livrés.

### Tests

- **Serveur** (`node:test`, SQLite en mémoire) : clé absente ou fausse, pré-vol CORS, validation et plafonds, règles de fusion 1 à 5, forme de `pull` (10 dernières de chaque), `known`, limite de débit.
- **Client** (harnais existant, pool simulé) :
  - ajout à la file aux bons points d'accroche ;
  - données reçues jamais renvoyées ;
  - envoi par lots et attente qui double après un échec ;
  - fusion de `pull` (Pro avec `by`, ventes observées) ;
  - `known` qui réduit `finQ` avant la lecture des prix finaux ;
  - clé absente des sauvegardes et du fichier ami ;
  - script inchangé quand le pool est désactivé.
- **Pendant la panne de fibre** : tout se teste hors ligne (Node). L'essai réel sur le site attend le retour de la connexion, puisque le site lui-même est alors injoignable.

## Phase 2 — annonces partagées (esquisse, plan séparé)

- Une table `listings` : enchère (clé), carte, rareté, prix, offre oui/non, fin, vue le, membre.
- Envoi depuis `ingestMarket`. Réception pour la collection et les souhaits, qui remplit « En vente à » et les colonnes d'annonces des souhaits sans que chacun balaie le marché.
- Une annonce finie est retirée dès que son prix final est connu.
- But : le relevé d'un membre sert à tous, et le site reçoit moins de requêtes.

## Décisions

**Prises par Jules**
- Base partagée pour tout son groupe de potes, Pro et non-Pro mélangés.
- Auto-hébergée sur optimus (TrueNAS).
- Moteur SQLite.
- On garde tout, et les annonces viendront en phase 2.

**Mes choix** (à corriger si besoin)
- Le code serveur vit dans `server/` de ce dépôt.
- Zéro dépendance, image Node officielle avec le code monté, sans construction d'image.
- Une seule clé de groupe partagée, à changer si elle fuit.
- Le pseudo du membre est visible des autres, comme « relevé partagé par X » en v1.19.
- La case « Partager et recevoir » est désactivée par défaut.
- Ce qui est reçu n'est jamais renvoyé.
- Seuils : réception toutes les 6 h, envoi toutes les 15 s, 120 requêtes par minute par membre.
- Les relevés Pro « aucune vente » ne sont pas envoyés en phase 1, comme dans le fichier ami. Conséquence acceptée : un compte Pro redemande au site les cartes jamais vendues.
- Les prix reçus du pool ne nourrissent pas le niveau de prix par rareté, qui reste fait des observations locales. Ce sera à reprendre quand les stats seront faites côté serveur.

**Laissé au constructeur**
- La forme exacte des requêtes SQL, l'organisation interne des fichiers serveur.
- Les textes exacts des Réglages, le détail de l'attente entre les essais.

## Questions réglées

- Accès depuis Internet : Cloudflare Tunnel, puisque Jules a un domaine sur Cloudflare.
- TrueNAS 25.10 sur optimus, compatible avec le déploiement prévu.
