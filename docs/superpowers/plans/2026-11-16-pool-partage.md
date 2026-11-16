# Pool de prix partagé — plan d'implémentation (phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** un serveur auto-hébergé (SQLite) qui met en commun les prix de tout le groupe, et le client dans le script qui envoie ce qu'il relève, reçoit ce qui lui sert et évite au site les relectures inutiles.

**Architecture :**
- `server/` : un service Node sans dépendance, en CommonJS, découpé en `db.js` (schéma, fusion), `validate.js` (contrôle des envois) et `server.js` (HTTP, clé, CORS, limites).
- Le script ajoute un module « pool » : file d'envoi, réception, `known`. Il réutilise les formats et les fonctions de fusion de la v1.19.

**Tech stack :** Node 24 (`node:http`, `node:sqlite`, `node:crypto`, `node:test`), userscript sans dépendance, TrueNAS 25.10 + Cloudflare Tunnel pour le déploiement.

**Spec :** `docs/superpowers/specs/2026-11-16-pool-partage-design.md`

## Global Constraints

- **Dépendances** : aucune dépendance npm, Node 24 au minimum, les fichiers serveur en CommonJS.
- **Textes** visibles en français, tutoiement.
- **Version du script** : `1.20.0`, à deux endroits (`@version` et `VERSION`).
- **Environnement serveur** :
  - `GROUP_KEY` : au moins 24 caractères, sinon refus de démarrer ;
  - `DB_PATH` : `/data/pool.db` par défaut ;
  - `PORT` : `8787` par défaut ;
  - `ALLOWED_ORIGINS` : `https://www.wiki-masters.com,https://wiki-masters.com` par défaut.
- **Plafonds par requête** :
  - corps de 2 Mo au plus (au-delà : 413) ;
  - `pro` 2000, `sales` 5000, `unsold` 5000 par envoi (au-delà : 413) ;
  - `pull` 500 cartes et `known` 1000 enchères (au-delà : 400).
- **Débit** : 120 requêtes par minute par adresse (`CF-Connecting-IP`, sinon le premier `X-Forwarded-For`, sinon la connexion). Au-delà : 429 avec `Retry-After`.
- **Rythme du client** :
  - envoi toutes les 15 s, file plafonnée à 20 000 entrées ;
  - en cas d'échec, attente de 1 min doublée à chaque fois, jusqu'à 30 min ;
  - réception de la collection et des souhaits toutes les 6 h ;
  - cartes vues regroupées après 2 s.
- **Sécurité des données** :
  - le partage est désactivé par défaut ;
  - ce qui vient du pool, d'un fichier ami ou d'une sauvegarde n'est jamais renvoyé ;
  - `db.pool` n'apparaît ni dans la sauvegarde ni dans le fichier ami.
- **Tests** : `node --test test/*.test.js`. Les tests serveur vivent aussi dans `test/`.

## Review Focus

1. **Pool injoignable** (fibre coupée, DNS, CORS refusé) au moment d'un envoi, d'une réception ou d'un `known` : le script n'est pas gêné, et « Relever les prix finaux » lit quand même le site. Testé dans la tâche 5.
2. **Écho** : une vente envoyée puis reçue en retour ne crée pas de doublon local. Testé dans la tâche 5.
3. **Mauvaise clé** (401) : l'erreur est affichée, la file est gardée, l'attente s'applique et aucun nouvel essai ne part en boucle. Testé dans la tâche 4.
4. **Même envoi reçu deux fois** (le client réessaie alors que le serveur avait déjà enregistré) : aucune ligne en double. Testé dans la tâche 1.
5. **File de plus de 20 000 entrées** : les plus anciennes sautent, et l'envoi se fait en plusieurs lots. Testé dans la tâche 4.

---

### Task 1 : base et règles de fusion (`server/db.js`, `server/validate.js`)

**Files :** Create `server/db.js`, `server/validate.js`, `test/server-db.test.js`.

**Interfaces (produites) :**
- `openDb(path: string) → DatabaseSync` : crée le schéma de la spec (tables `sales` et `pro_fetch`, index), en mode WAL sauf pour `:memory:`.
- `parsePush(body: object, now: number) → { member, pro, sales, unsold }` (dans `validate.js`) :
  - lève `{ status: 400 }` si la forme est fausse et `{ status: 413 }` au-delà des plafonds ;
  - ignore sans erreur les entrées invalides (identifiant non sûr, prix ≤ 0 ou non entier, date illisible) ;
  - ramène à `now` une date `at` future ;
  - `member` est coupé à 40 caractères, « anonyme » si vide.
- `applyPush(db, push, now: number) → { added, upgraded, dropped }` : règles 1 à 5 de la spec, dans une transaction.
- `pullCards(db, ids: string[]) → { cards: { [id]: { pro: { at, by, sales: [[p, t], …] } | null, sales: [[p, t, g, x, auction], …] } } }` : les 10 dernières par date, pour les `pro` d'un côté, pour les `exact` et `prov` de l'autre. Une carte absente n'apparaît pas.
- `knownAuctions(db, ids: string[]) → { exact: { [auction]: [card, p, t] } }` : uniquement les lignes `exact` ou `pro` qui portent un numéro d'enchère.
- `poolStats(db) → { sales, cards, members, lastPushAt }`.
- `purgeMember(db, member: string) → number` : nombre de lignes supprimées.

- [ ] **Écrire les tests** dans `test/server-db.test.js` (base `:memory:`, `now = Date.parse('2026-11-16T12:00:00Z')`) :
  - `insertion puis pull` : un `pro` `['C1', now-1000, [[50,'2026-11-10T00:00:00Z'],[40,'2026-11-09T00:00:00Z']]]` par « Jules » donne, pour C1, `pro = { at: now-1000, by: 'Jules', sales: [[50,'2026-11-10T00:00:00Z'],[40,'2026-11-09T00:00:00Z']] }` et `sales = []`.
  - `règle 1, prov puis exact sur la même enchère` : `sales` `['C1',30,T,10,0,'A1']`, puis `['C1',45,T2,0,1,'A1']`. Résultat `{added:0, upgraded:1}`, et le pull donne `sales = [[45,T2,0,1,'A1']]`.
  - `règle 2, pro puis exact même date et même prix` : une seule ligne en base. Elle reste `pro` (donc dans la partie `pro` du pull, pas dans `sales`), reçoit l'enchère `A2`, et `knownAuctions(['A2'])` la renvoie.
  - `règle 4, unsold` : un `prov` `A3`, puis `unsold: ['A3']`. Résultat `{dropped:1}`, et la ligne disparaît.
  - `règle 5, pro_fetch garde le plus récent et refuse le futur` : `at = now + 1e9` est enregistré comme `now`, et un `at` plus ancien ne remplace rien.
  - `idempotence` : appliquer deux fois le même envoi donne `added` à 0 la deuxième fois, sans aucune ligne en plus.
  - `pull limité à 10` : 12 ventes `exact` de C1 donnent 10 lignes, les plus récentes.
  - `parsePush` :
    - `sales` à 5001 entrées donne `413` ;
    - `{}` donne un envoi vide (pas une erreur) ;
    - les entrées `['__proto__',5,T,0,1,'']`, `['C',-1,T,0,1,'']`, `['C',5,'pas une date',0,1,'']` sont ignorées ;
    - `member` vide donne « anonyme ».
  - `purgeMember` supprime les lignes du membre et renvoie leur nombre.
- [ ] **Lancer** `node --test test/*.test.js` : échec (module absent).
- [ ] **Implémenter** `server/db.js` et `server/validate.js`.
  - Règles 1 et 2 : chercher la ligne existante par `auction`, sinon par `(card, sold_at, price)`.
  - Une ligne finale (`exact` ou `pro`) remplace un `prov`. Une ligne `exact` qui arrive sur une ligne `pro` lui ajoute l'enchère, et la ligne reste `pro` : l'historique Pro de la carte reste complet.
  - Quand un `prov` devient final et qu'une ligne `pro` représente déjà cette vente, le `prov` est supprimé et la ligne `pro` reçoit l'enchère.
  - Les dates sont normalisées à l'entrée (`new Date(t).toISOString()`), pour que la même vente envoyée par deux membres soit reconnue.
- [ ] **Lancer** : succès.
- [ ] **Commit** « Serveur du pool : base SQLite et règles de fusion ».

### Task 2 : routes HTTP (`server/server.js`)

**Files :** Create `server/server.js`, `test/server-http.test.js`.

**Interfaces :**
- Consomme : la tâche 1.
- Produit : `createHandler({ db, groupKey, allowedOrigins, now = Date.now, perMinute = 120 }) → (req, res) => void`.
- Produit : `start({ dbPath, port, groupKey, allowedOrigins }) → Promise<http.Server>`. Il lève une erreur si `groupKey.length < 24`.
- Lancé directement (`require.main === module`), il lit l'environnement et démarre.
- `VERSION = '1.0.0'`.

- [ ] **Écrire les tests** (serveur réel sur le port `0`, `fetch` de Node) :
  - `GET /v1/health` sans clé donne `200 { ok: true, version: '1.0.0' }`.
  - `POST /v1/push` sans clé ou avec une mauvaise clé donne `401`. La bonne clé donne `200 { added: 1, … }`.
  - Pré-vol `OPTIONS /v1/push` avec `Origin: https://www.wiki-masters.com` donne `204`, avec les en-têtes :
    - `access-control-allow-origin` égal à cette origine ;
    - `access-control-allow-headers` qui contient `x-group-key` ;
    - `access-control-max-age: 600` ;
    - `access-control-allow-private-network: true`.
  - Une origine `https://evil.example` ne reçoit **pas** `access-control-allow-origin`.
  - Un corps de plus de 2 Mo donne `413`. Un JSON invalide donne `400`.
  - `POST /v1/pull` avec 501 cartes donne `400`. `POST /v1/known` avec 1001 enchères donne `400`.
  - Débit : avec `perMinute = 3`, la quatrième requête venant du même `CF-Connecting-IP` reçoit `429` avec un en-tête `retry-after`. Un autre `CF-Connecting-IP` passe.
  - Une route inconnue donne `404`.
- [ ] **Lancer** : échec.
- [ ] **Implémenter** `server/server.js`.
  - Comparer la clé avec `crypto.timingSafeEqual` sur deux tampons de même longueur.
  - Limite de débit : une fenêtre glissante d'une minute par adresse, dans une `Map` nettoyée chaque minute.
  - Ne jamais journaliser la clé.
- [ ] **Lancer** : succès.
- [ ] **Commit** « Serveur du pool : routes, clé, CORS et limites ».

### Task 3 : administration et déploiement

**Files :** Create `server/admin.js`, `server/docker-compose.yml`, `server/README.md`. Test : `test/server-db.test.js` (la purge, déjà couverte).

**Interfaces :**
- `node server/admin.js stats` affiche `poolStats` en JSON.
- `node server/admin.js purge <membre>` affiche le nombre de lignes supprimées.
- Les deux lisent `DB_PATH`.

- [ ] **`docker-compose.yml`**, deux services :
  - `wm-pool` :
    - image `node:24-alpine`, commande `node /app/server.js` ;
    - volumes `/mnt/<pool>/apps/wm-pool/app:/app:ro` et `/mnt/<pool>/apps/wm-pool/data:/data` ;
    - environnement `GROUP_KEY`, `ALLOWED_ORIGINS`, `restart: unless-stopped` ;
    - aucun port publié.
  - `cloudflared` :
    - image `cloudflare/cloudflared:latest`, commande `tunnel run` ;
    - environnement `TUNNEL_TOKEN`, `restart: unless-stopped`.
- [ ] **`server/README.md`**, guide pas à pas :
  1. créer le dataset `apps/wm-pool` et ses dossiers `app/` et `data/` ;
  2. copier le contenu de `server/` dans `app/` ;
  3. générer une clé avec `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` ;
  4. Cloudflare Zero Trust : créer le tunnel, copier le jeton, et faire pointer le nom public `pool.<domaine>` vers `http://wm-pool:8787` ;
  5. TrueNAS : Apps → Discover → ⋮ → Install via YAML, coller le compose et remplir les variables ;
  6. vérifier `https://pool.<domaine>/v1/health` ;
  7. créer une tâche d'instantané ZFS du dataset ;
  8. donner l'URL et la clé aux membres par message privé ;
  9. mise à jour : recopier `app/`, puis redémarrer l'application.
- [ ] **Vérifier** que `node server/admin.js stats` répond `{"sales":0,…}` sur une base vide (`DB_PATH=$TMP/x.db`).
- [ ] **Commit** « Serveur du pool : administration, compose TrueNAS, guide ».

### Task 4 : client — réglages, file d'envoi, points d'accroche

**Files :** Modify `wikimasters-stats.user.js`, `test/harness.js` (exposer les nouvelles fonctions et `backupData`). Create `test/pool-client.test.js`.

**Interfaces (produites) :**
- Données : `db.pool = { url: '', key: '', on: false, pushAt: 0, pullAt: 0, sent: 0, recv: 0, err: '', retryAt: 0, wait: 0 }` (défauts dans `defaults()`) et `db.poolQ = []`.
- `poolOn() → boolean` : vrai si `on` est coché et que `url` et `key` sont remplis.
- `poolQueue(type: 'p' | 's' | 'u', entry) → void` :
  - une entrée `p` vaut `[card, at, [[p, t], …], rarity]` ;
  - une entrée `s` vaut `[card, p, t, g, x, auction, rarity]` ;
  - une entrée `u` vaut l'identifiant d'enchère ;
  - rien ne se passe si `!poolOn()` ;
  - au-delà de 20 000 entrées, les plus anciennes sautent.
- `poolFetch(path: string, body?: object) → Promise<any>` :
  - `POST` si `body`, sinon `GET`, avec les en-têtes `x-group-key` et `content-type` et `credentials: 'omit'` ;
  - lève une erreur `{ status }` si la réponse n'est pas ok.
- `poolFlush(now?) → Promise<void>` :
  - un lot de 2000 `p`, 5000 `s` et 5000 `u` au plus, envoyé par `POST /v1/push` avec `member: db.me || 'anonyme'` ;
  - en cas de succès, retire le lot de la file, met à jour `sent` et `pushAt`, et remet `wait` à 0 ;
  - en cas d'échec, enregistre l'erreur dans `err`, passe `wait` à `min(max(wait*2, 60000), 1800000)` et fixe `retryAt = now + wait`.
- `backupData() → object` : extrait de `exportBackup`, sans changement de contenu.
- Points d'accroche, comme dans le tableau de la spec : `ingestSales`, `settleObserved` (quand `addObserved` renvoie vrai), `ingestFinal` (prix final, ou invendu), `recordAuction` (seulement une enchère nouvelle, à prix final, non shiny).
- Minuterie : toutes les 15 s, `poolFlush()` si `poolOn()`, que la file n'est pas vide, que `Date.now() >= retryAt` et qu'aucun envoi n'est en cours.
- Réglages : le groupe « Pool partagé du groupe (tous comptes) », avec l'URL (texte), la clé (mot de passe), la case et le bouton « Tester ». « Tester » appelle `poolFetch('/v1/stats')` et affiche « Connecté : N ventes, M cartes, K membres », ou l'erreur. La ligne d'état est mise à jour dans `syncButtons`.

- [ ] **Écrire les tests** (`test/pool-client.test.js`, avec un pool simulé par le `fetch` du harnais selon les adresses `https://pool.test/…`) :
  - `pool désactivé` : `poolQueue('s', …)` ne met rien dans la file.
  - `ingestSales met un relevé Pro en file` : avec le pool activé, `ingestSales('C1', { recent: [{ final_price: 50, settled_at: T }] })` donne `db.poolQ` égal à `[['p', ['C1', <at>, [[50, T]], <rareté ou null>]]]`.
  - `ingestFinal` : une enchère suivie avec un prix final donne une entrée `s` avec `x = 1` et l'enchère. Une enchère invendue avec un prix provisoire donne une entrée `u`.
  - `mergeObserved et mergePro ne mettent rien en file` (aucun écho).
  - `poolFlush` : envoie `{ member, pro, sales, unsold }` avec l'en-tête `x-group-key`, puis vide la file et donne `sent > 0`.
  - `401` : la file est gardée, `err` contient `401`, `wait` vaut 60000. Un deuxième échec donne 120000. Pendant l'attente (`Date.now() < retryAt`), la minuterie n'envoie rien.
  - `file de 20 001 entrées` : 20 000 restent, la première ajoutée a disparu. Les lots respectent les plafonds : avec 6000 `s`, il faut deux envois.
  - `backupData()` et `friendExport('Jules')` ne contiennent pas la clé : le JSON ne contient pas la valeur de `db.pool.key`.
- [ ] **Lancer** : échec.
- [ ] **Implémenter** dans le script. `exportBackup` appelle `backupData()`.
- [ ] **Lancer** : succès. Les tests existants passent toujours.
- [ ] **Commit** « Client du pool : réglages, file d'envoi, points d'accroche ».

### Task 5 : client — réception, `known`, relevés Pro sautés

**Files :** Modify `wikimasters-stats.user.js`, `test/pool-client.test.js`.

**Interfaces :**
- Consomme : la tâche 4, plus `mergePro` et `mergeObserved` (v1.19).
- `poolPull(ids: string[]) → Promise<number>` :
  - par lots de 500, `POST /v1/pull` ;
  - `pro` devient `mergePro([[id, pro.at, pro.sales, pro.by]], 'groupe')`, et `sales` devient `mergeObserved({ sales: sales.map(s => [id, ...s]) })` ;
  - renvoie le nombre de prix ajoutés et met à jour `recv`.
- `poolPullMine(force?: boolean) → Promise<void>` : la collection et les souhaits, si `force` ou si `Date.now() - pullAt >= 6 h`. Appelé après un chargement complet de la collection, après `ingestWish`, et à l'ouverture du panneau.
- `poolWant(cardId: string) → void` : met de côté les cartes vues sans prix, puis lance `poolPull` sur le lot après 2 s. Chaque carte n'est demandée qu'une fois par visite. Appelé depuis `scanCards`.
- `poolKnown() → Promise<number>` :
  - `POST /v1/known` avec les 1000 premières enchères de `finQ` ;
  - fusionne les prix exacts via `mergeObserved` (avec le numéro d'enchère) ;
  - retire ces enchères de `finQ` et renvoie leur nombre.
- `poolPrefetch(ids: string[]) → Promise<void>` : `poolPull(ids)`, en ignorant toute erreur. Appelé au début de `fillPrices`, `fillTradePrices`, `fetchPricesFor`, `runPullQueue` et `runBidQueue`, dont la liste est ensuite refiltrée avec `priceStale`.
- `fetchFinals` et `autoRun` appellent `poolKnown()` avant `finalsToFetch()` si `poolOn()`, dans un `try` qui ignore les erreurs.

- [ ] **Écrire les tests** :
  - `poolPull fusionne` : la réponse simulée pour C1 donne `db.prices.C1.by === 'Marie'` et `db.obsSales.C1[0].x === 1`. Avec `db.me = 'Marie'`, le relevé n'a pas de `by`.
  - `écho` : une vente déjà locale (même enchère) reçue du pool ne crée pas de deuxième entrée dans `db.obsSales`.
  - `poolKnown réduit finQ` : avec `finQ = { A1, A2 }` et le pool qui connaît `A1`, il ne reste que `A2`. Ensuite, `fetchFinals` ne demande au site que `/api/marketplace/A2`.
  - `pool injoignable` : quand le `fetch` simulé lève une erreur pour `pool.test`, `fetchFinals` lit quand même `A1` et `A2` sur le site, et `db.pool.err` est rempli.
  - `relevés Pro sautés` : quand le pool renvoie un `pro` frais (`at = now`) pour C1, `fillPrices` ne demande pas `/api/marketplace/cards/C1/sales` au site.
  - `poolPullMine` : ne fait rien si le dernier passage date de moins de 6 h, sauf avec `force`.
- [ ] **Lancer** : échec.
- [ ] **Implémenter.**
- [ ] **Lancer** : succès.
- [ ] **Commit** « Client du pool : réception, enchères déjà connues, relevés Pro sautés ».

### Task 6 : textes, version, vérification d'ensemble

**Files :** Modify `README.md`, `wikimasters-stats.user.js` (passage à 1.20.0).

- [ ] **README** : une section « Pool partagé du groupe », qui explique :
  - à quoi il sert ;
  - qu'il est désactivé par défaut ;
  - qu'on saisit l'URL et la clé reçues de l'administrateur ;
  - ce qui est partagé (prix, jamais la collection ni la clé) ;
  - qu'une panne du pool ne casse rien ;
  - le renvoi vers `server/README.md` pour l'héberger.
- [ ] **Version** 1.20.0 aux deux endroits.
- [ ] **Lancer** `node --check wikimasters-stats.user.js`, puis `node --test test/*.test.js` : tout passe.
- [ ] **Commit** « v1.20 : pool de prix partagé du groupe ».
