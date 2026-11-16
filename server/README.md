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

## Installation sur TrueNAS (25.10)

### 1. Le dataset

Storage → crée un dataset `apps/wm-pool` (préréglage « Apps »), puis deux dossiers dedans : `app` et `data`. Le propriétaire doit être l'utilisateur `apps` (568), celui de l'application.

### 2. Le code

Copie le contenu de ce dossier `server/` dans `apps/wm-pool/app`. Ce sont les fichiers `server.js`, `db.js`, `validate.js` et `admin.js`. Tu peux passer par le partage SMB du NAS, ou par `scp`.

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

Ouvre `https://pool.<ton domaine>/v1/health`. Tu dois voir `{"ok":true,"version":"1.0.0"}`.

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
