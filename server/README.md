# Pool de prix partagé — serveur

Le serveur qui met en commun les prix de tout ton groupe. Chaque membre qui active « Pool partagé du groupe » dans les Réglages du script envoie les prix qu'il relève, et reçoit ceux des autres. Pro et non-Pro mélangés.

Node 24, aucune dépendance (SQLite intégré à Node). Il tourne sur TrueNAS avec l'image Node officielle : pas d'image à construire. L'accès depuis Internet passe par un tunnel Cloudflare, sans ouvrir de port sur ta box.

## Ce qu'il garde

Toutes les ventes reçues, sans limite de durée :
- l'historique Pro ;
- les prix finaux lus sur les pages d'enchères ;
- les dernières offres vues ;
- les ventes et achats des membres.

Pour chaque vente, il garde aussi le pseudo du membre qui l'a envoyée. Il ne reçoit jamais la collection d'un membre, ni ses souhaits, ni rien de son compte.

## En attendant le NAS : le pool sur ton PC (temporaire)

Tant que le pool du NAS n'est pas en ligne, tu peux le faire tourner sur ton PC. Tes navigateurs de ce PC (Chrome, Zen) et tes comptes partagent alors leurs prix, sans NAS ni tunnel. Le jour où le NAS est prêt, tout ce que ce pool a reçu y part tout seul, et tu n'as plus besoin de lui.

Il faut Node 24 ou plus récent ([nodejs.org](https://nodejs.org)). Pour tes potes, la même chose expliquée pas à pas est dans le [guide](../GUIDE.md#cas-b--en-attendant-le-nas-le-pool-sur-ton-pc-temporaire).

**Démarrer**

1. Double-clique sur `server/start-local.cmd`. La fenêtre affiche l'adresse (`http://127.0.0.1:8787`) et la clé. La clé est créée la première fois, dans `Documents\wm-pool\cle.txt`, à côté de la base `pool.db`.
2. Dans le script, onglet Réglages, groupe « Pool partagé du groupe » :
   1. colle l'adresse et la clé ;
   2. clique « Tester » ;
   3. coche « Partager et recevoir les prix ».
3. Laisse la fenêtre ouverte (ou réduis-la) pendant que tu joues.

Chrome peut te demander si wiki-masters.com a le droit d'accéder aux applications de cet appareil : accepte, c'est le pool local. Il n'écoute que ce PC (adresse `127.0.0.1`) : les autres machines du réseau ne peuvent pas l'atteindre, et tes potes devront attendre le NAS.

**Quand le pool du NAS est en ligne**

1. Dans `Documents\wm-pool`, crée un fichier `amont.txt` avec, sur une seule ligne, l'adresse du NAS et sa clé, séparées par un espace :
   `https://pool.ton-domaine.fr la-cle-du-nas`
2. Ferme la fenêtre du pool local et relance `start-local.cmd`. Elle affiche « Synchro : vers https://pool… ». Le pool local envoie tout ce qu'il a reçu, puis il continue toutes les 5 minutes.
3. Vérifie que c'est passé : `http://127.0.0.1:8787/v1/health` affiche `"upstream":{"at":…,"err":"","sent":…}`, avec un `err` vide.
4. Dans le script, remplace l'adresse et la clé par celles du NAS, puis clique « Tester ».
5. Ferme la fenêtre du pool local. Tu peux garder `Documents\wm-pool` quelque temps par sécurité, puis le supprimer.

Renvoyer deux fois les mêmes ventes ne crée aucun doublon, et si le NAS ne répond pas, rien n'est perdu : le passage suivant reprend là où il s'était arrêté. Pour forcer un envoi sans attendre : `node server/admin.js sync <adresse> <clé>`, avec `DB_PATH` pointant vers `Documents\wm-pool\pool.db`.

## Installation sur TrueNAS (25.10)

### 1. Le dataset

Storage → crée un dataset `apps/wm-pool` (préréglage « Apps »), puis deux dossiers dedans : `app` et `data`. Le propriétaire doit être l'utilisateur `apps` (568), celui de l'application.

### 2. Le code

Copie le contenu de ce dossier `server/` dans `apps/wm-pool/app`. Ce sont les fichiers `server.js`, `db.js`, `validate.js`, `sync.js` et `admin.js` : les cinq sont nécessaires, le serveur ne démarre pas s'il en manque un. Tu peux passer par le partage SMB du NAS, ou par `scp`.

### 3. La clé du groupe

Génère une clé longue et aléatoire, sur n'importe quel ordinateur avec Node :

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Garde-la : tu la mettras dans l'application, puis tu la donneras à tes potes. Elle ne doit **jamais** aller dans le code ni dans un dépôt.

### 4. Le tunnel Cloudflare

Dans Cloudflare : Zero Trust → Networks → Tunnels → « Create a tunnel » (type Cloudflared).

1. Donne-lui un nom (par exemple `wm-pool`) et copie le **jeton** affiché, la longue chaîne après `--token`.
2. Onglet « Public Hostname » : ajoute `pool.<ton domaine>`, avec le service `HTTP` et l'URL `wm-pool:8787`.

### 5. L'application

Dans TrueNAS : Apps → Discover Apps → menu ⋮ → **Install via YAML**.

1. Nomme-la `wm-pool`.
2. Colle le contenu de `docker-compose.yml`.
3. Remplace `<POOL>` par le nom de ton pool de stockage.
4. Remplis `GROUP_KEY` (la clé de l'étape 3) et `TUNNEL_TOKEN` (le jeton de l'étape 4).
5. Installe.

### 6. Vérifier

Ouvre `https://pool.<ton domaine>/v1/health`. Tu dois voir `{"ok":true,"version":"1.1.0"}`.

### 7. Sauvegardes

Data Protection → Periodic Snapshot Tasks : crée une tâche quotidienne sur `apps/wm-pool` (gardée 2 semaines, par exemple). La base est un seul fichier, `data/pool.db`.

### 8. Donner l'accès à tes potes

Envoie-leur en message privé l'URL `https://pool.<ton domaine>` et la clé. Dans le script, onglet Réglages, groupe « Pool partagé du groupe » : ils collent les deux, cliquent « Tester », puis cochent « Partager et recevoir les prix ».

Si la clé fuit, change-la (étapes 3 et 5) et redonne-la au groupe.

## Mise à jour

Recopie les fichiers de `server/` dans `apps/wm-pool/app`, puis redémarre l'application dans TrueNAS.

## Administration

Dans TrueNAS : Apps → wm-pool → Shell (conteneur `wm-pool`) :

```bash
node /app/admin.js stats            # nombre de ventes, de cartes et de membres
node /app/admin.js purge <membre>   # retire tout ce qu'un membre a envoyé
node /app/admin.js sync <adresse> <clé>   # envoie ce pool vers un autre (le pool local vers le NAS)
```

## Si le NAS ou ta connexion tombe

Le script de chacun continue normalement avec ses propres données. Les envois attendent et repartent tout seuls au retour du pool. Rien n'est perdu côté membres.

## Les routes (pour info)

| Route | Rôle |
|---|---|
| `GET /v1/health` | état du serveur, sans clé |
| `GET /v1/stats` | compteurs |
| `POST /v1/push` | envoi de prix (historique Pro, ventes, invendus) |
| `POST /v1/pull` | prix de 500 cartes au plus |
| `POST /v1/known` | parmi 1000 enchères au plus, celles dont le prix final est déjà connu |

Toutes, sauf `health`, demandent l'en-tête `x-group-key`. Limite : 120 requêtes par minute et par membre.
