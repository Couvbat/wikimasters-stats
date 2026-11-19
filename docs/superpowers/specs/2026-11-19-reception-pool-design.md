# Réception incrémentale de tout le pool — conception

Script 1.28.0, serveur du pool 1.4.0.

## Pourquoi

Aujourd'hui, le script ne reçoit du pool que les cartes qu'il demande, et il redemande tout leur historique à chaque fois :

- ta collection et tes souhaits, toutes les 6 h et à chaque ouverture du panneau (`poolPullMine`) ;
- une carte affichée par le site sans aucun prix, une fois par visite (`poolWant`) ;
- les cartes dont il va relire l'historique Pro (`poolPrefetch`).

Depuis la 1.27, une carte peut porter jusqu'à 2 000 ventes de chaque sorte. Redemander toute ta collection revient donc à retélécharger des milliers de ventes déjà connues. En même temps, une carte qui n'est ni à toi ni dans tes souhaits reste sans prix tant que le site ne l'a pas affichée.

Jules veut que le script reçoive **tout le pool**, mais **seulement ce qui a changé** depuis le dernier passage. Ça sert aussi la future fiche par carte (conception à part) : pour juger une carte du marché qu'on n'a pas, il faut son historique sous la main.

## Décisions de Jules

- **Tout le pool**, toutes cartes confondues, et pas seulement sa collection et ses souhaits.
- **Seulement les nouveautés** depuis le dernier passage.

## Objectifs

- Recevoir une première fois tout le pool (aujourd'hui 64 968 ventes sur 12 477 cartes, de 5 à 7 Mo selon la compression), puis seulement ce qui a changé.
- Recevoir les relevés des amis vite : un passage toutes les **15 minutes**, plus un à l'ouverture du panneau *(choix de Claude : un passage ne transporte presque rien)*.
- Faire disparaître chez soi les prix provisoires que le pool a retirés : enchère finie sans vente, ou provisoire remplacé par une vente déjà connue *(choix de Claude)*.

## Hors sujet

- Propager la purge d'un membre (`admin.js purge`). Aujourd'hui non plus, une vente déjà reçue ne disparaît pas quand on la purge du pool.
- Les profils des amis (`/v1/profiles`) : ils gardent leur réception actuelle.
- L'envoi vers le pool (`/v1/push`) et le relais entre pools (`server/sync.js`) : rien ne change.
- Le fichier ami et la sauvegarde : ils gardent leurs plafonds (8 000 ventes observées, 8 000 relevés Pro). Ils ne gonflent pas avec le pool.
- `/v1/known` reste tel quel.

## À éviter absolument

- **Perdre une vente.** Un passage interrompu (page fermée, réseau coupé, pool redémarré) reprend là où il s'était arrêté, sans trou.
- **Chasser tes propres cartes.** Aujourd'hui, le script garde des ventes observées pour **8 000 cartes** au plus (`MAX_OBS_CARDS`). Au-delà, il retire les cartes dont la dernière vente est la plus ancienne. Le pool en compte déjà 12 477 : sans changement, la réception de tout le pool retirerait des cartes, y compris les tiennes.
- **Casser le mode secours** (ancien stockage `localStorage`, limité à 5 Mo). Tout le pool n'y tient pas.
- **Casser les versions mélangées.** Un ami encore en 1.27 doit continuer de recevoir, et un script 1.28 face à un pool encore en 1.3.0 aussi.

## Approches envisagées

1. **Un fil des nouveautés, par numéro d'ordre (retenue).** Chaque ligne du pool reçoit déjà un numéro strictement croissant (`rev`) quand elle arrive ou change : vente, relevé Pro, enchère sans vente. C'est ce qui sert au relais entre pools. Le script demande « tout ce qui suit le numéro N », page par page, puis garde le dernier numéro reçu.
2. **Carte par carte, avec une date.** Le script enverrait la liste de ses cartes avec la date du dernier passage. Il faudrait envoyer 12 477 identifiants à chaque passage, et une carte apparue entre-temps passerait inaperçue. Écartée.
3. **Retélécharger tout le pool.** C'est le plus simple, mais ça fait 5 Mo toutes les 15 minutes, et de plus en plus. Écartée.

## Conception

### Serveur 1.4.0 : `GET /v1/feed`

- **Requête :** `GET /v1/feed?since=<N>&limit=<L>`, avec l'en-tête `x-group-key` comme les autres routes.
  - `since` est un entier ≥ 0 (0 la première fois).
  - `limit` vaut 5 000 lignes par défaut et 10 000 au plus.
  - Une valeur invalide renvoie 400.
- **Contenu :** les lignes dont `rev > since`, toutes tables confondues, dans l'ordre des numéros, `limit` au plus en tout :
  - les **ventes** (`sales`), y compris celles qui ont changé depuis : prix provisoire devenu final, numéro d'enchère ajouté, provisoire devenu vente Pro ;
  - les **relevés Pro** (`pro_fetch`) : carte, date du relevé, auteur ;
  - les **enchères à retirer** (`unsold_queue`) : enchère finie sans vente, ou prix provisoire supprimé parce que la même vente était déjà connue.
- **Réponse** (forme indicative, les noms exacts sont laissés au développeur) :

  ```json
  { "pool": "<identifiant du pool>", "max": 123456, "next": 5000, "more": true,
    "sales":  [[rev, carte, prix, date, sorte, enchère, écart, rareté], ...],
    "pro":    [[rev, carte, date du relevé, auteur], ...],
    "unsold": [[rev, enchère], ...] }
  ```

  - `sorte` vaut `pro`, `exact` ou `prov`.
  - Une vente `pro` porte en plus, à la fin, la date et l'auteur du relevé Pro de sa carte (`0` et `null` s'il n'y en a pas). Sa ligne a pu prendre un numéro plus grand que celui du relevé, par exemple quand une enchère s'y accroche après coup. Le relevé arrive alors dans une page précédente, avant les ventes qu'il date. *(ajout après la relecture finale)*
  - `next` est le numéro de la dernière ligne rendue. Le script le renvoie comme `since` à la page suivante.
  - `more` dit s'il reste des lignes après cette page.
  - `max` est le plus grand numéro du pool au moment de la réponse.
  - Le pseudo de celui qui a relevé une vente observée n'est pas rendu, comme aujourd'hui dans `/v1/pull`. L'auteur d'un relevé Pro l'est, comme aujourd'hui.
- **Identifiant du pool :** un identifiant aléatoire créé une fois pour toutes dans `meta` (clé `pool_id`), à la création de la base ou à la migration. Il sert au script à reconnaître qu'il parle à une autre base.
- **Les autres routes ne changent pas :** `/v1/pull` reste pour les scripts 1.27 et pour le mode secours. `/v1/health` donne la version `1.4.0`.
- Le délai par adresse (120 requêtes par minute) suffit : la première réception fait environ 13 pages de 5 000 lignes.
- **Pas de trou possible entre deux pages.**
  - Le serveur traite une requête à la fois, et `node:sqlite` est synchrone.
  - Un envoi (`applyPush`) prend ses numéros et les écrit dans une seule transaction.
  - Quand le fil répond, toute ligne dont le numéro est inférieur ou égal à `max` est donc déjà écrite.

### Script 1.28.0 : le passage

- **Quand le fil sert :** le pool est activé, le stockage est IndexedDB (`store.mode === 'idb'`) et le pool connaît `/v1/feed`.
- **Quand passer :** toutes les 15 minutes, depuis la boucle qui tourne déjà toutes les 15 s (`poolTick`), et à l'ouverture du panneau, à la place de la réception de ta collection.
  - Un seul passage à la fois. Avec plusieurs fenêtres du site, une seule fait le passage, grâce au verrou du navigateur (`navigator.locks`).
  - Si une autre fenêtre remplace les données pendant un passage, celui-ci s'arrête, et le tour suivant reprend depuis la position arrivée.
  - Un passage en échec suit un recul de 1 min, 2, 4… jusqu'à 30 min, comme `poolFailed`. Ce recul et l'erreur sont **propres au fil** : un envoi réussi ne les efface pas, et l'ouverture du panneau ne force pas un nouvel essai pendant le recul. *(précisé après la relecture finale)*
- **Une page :**
  1. Fusionner les ventes Pro, groupées par carte, avec `mergePro` (auteur par défaut : `groupe`).
     - La date du relevé vient de la ligne `pro` de la même carte, si elle est dans la page.
     - Sinon, la vente est rangée avec la date 1 (« relevé très ancien »), comme le fait déjà le relais entre pools (`NO_FETCH_DATE`). La vraie date arrive avec la ligne du relevé, dans cette page ou une suivante.
     - Une ligne `pro` met à jour la date et l'auteur du relevé de la carte (`db.prices[carte].at` et `.by`) quand elle est plus récente, même sans vente dans la page.
       - Attention : `mergePro` ignore une entrée sans ventes. On peut lui passer les ventes Pro déjà connues de la carte, ou écrire une petite fonction à part.
       - Une carte sans aucune vente Pro connue ne reçoit pas de relevé vide.
  2. Fusionner les ventes observées (`exact`, `prov`) avec `mergeObserved`, par paquets de 20 000 comme aujourd'hui.
  3. Appliquer les enchères à retirer :
     - retirer des ventes observées le prix **provisoire** de cette enchère, s'il y en a un (un prix exact n'est jamais retiré) ;
     - retirer l'enchère de la file des prix finaux à relever (`db.finQ`), puisque le site n'a plus rien à apprendre sur elle.
  4. Une vente rendue comme `pro` avec un numéro d'enchère retire aussi le prix provisoire de cette enchère : c'est la même vente, devenue Pro.
  5. Noter `next` comme nouvelle position, puis enregistrer. La position n'avance qu'après la fusion. Une page reçue deux fois ne crée aucun doublon, grâce aux règles de fusion existantes.
  6. Si `more`, demander la page suivante tout de suite.
- **Recommencer depuis zéro** (position 0) quand :
  - l'adresse du pool a changé ;
  - l'identifiant du pool a changé : base recréée, ou autre pool ;
  - la position est plus grande que `max` : base restaurée depuis une sauvegarde plus ancienne.

  Recommencer ne fait que re-fusionner, sans rien effacer.
- **Pool encore en 1.3.0** (`/v1/feed` répond 404) : le script note que le fil n'existe pas et garde l'ancienne réception (`poolPullMine`, `poolWant`, `poolPrefetch`). Il réessaie le fil toutes les 6 h, et quand on change l'adresse du pool.
- **Quand le fil sert, l'ancienne réception se tait :**
  - `poolPullMine` ne demande plus les cartes, mais continue de recevoir les profils des amis ;
  - `poolWant` ne fait rien ;
  - `poolPrefetch` ne fait rien, puisque les données ont au plus 15 minutes.
- **Mode secours** (`localStorage`) : rien ne change, ancienne réception et anciens plafonds.

### Plafonds du script

- **`MAX_OBS_CARDS`** passe à **50 000 cartes** en IndexedDB *(choix de Claude : quatre fois la taille du pool aujourd'hui)*. Il reste à 8 000 en mode secours.
- **Mesure :** enregistrer une base de la taille du pool coûte peu. Avec 105 000 ventes observées sur 15 000 cartes et 8 000 relevés Pro, `JSON.stringify` de la partie commune prend **environ 30 ms** pour 14 Mo. Ce coût suffit tel quel.
  - Si un enregistrement devient gênant à l'usage, les données du pool pourront passer sous une clé à part, écrite seulement quand elles changent. Ce n'est pas prévu dans cette version.

### Petit correctif lié

- **Un provisoire sans numéro d'enchère qui devient exact.** Un prix observé provisoire sans numéro d'enchère, rendu exact par le pool (même carte, même date, même prix), reste aujourd'hui provisoire chez soi : `addObserved` voit « même date, même prix » et ne change rien.
- Désormais, un prix **exact** à la même date et au même prix rend exact le provisoire déjà gardé.

### Affichage

Dans Réglages, la ligne d'état du pool dit où en est la réception *(choix de Claude)* :
- « réception de tout le pool : 30 000 ventes reçues » pendant la première réception ;
- « à jour il y a 3 min » ensuite ;
- « ancienne méthode (pool en 1.3.0) » quand le fil manque.

### Documentation et déploiement

- `server/README.md` :
  - la route `/v1/feed` dans « Les routes » ;
  - la version 1.4.0 ;
  - le rappel : mettre à jour le NAS (`server.js`, `db.js`, et `validate.js` s'il change).
- Après la fusion : mettre à jour le serveur du NAS en 1.4.0 (procédure habituelle). Ensuite, `/v1/health` doit répondre `{"ok":true,"version":"1.4.0"}`.

## Laissé au développeur

- La forme exacte de la réponse du fil, et la façon de fusionner les trois tables par numéro côté serveur.
- Le nom des champs de position dans `db.pool`.
- La table des enchères à retirer côté script : un index enchère → carte, construit une fois par passage.

## Tests attendus

**Serveur :**
- le fil rend tout dans l'ordre des numéros, page par page, sans trou ni doublon entre pages ;
- un provisoire devenu final revient dans le fil avec un numéro plus grand ;
- une enchère sans vente apparaît dans `unsold` ;
- l'identifiant du pool est stable d'un redémarrage à l'autre ;
- `since` et `limit` invalides renvoient 400 ;
- une base 1.3.0 migrée garde ses numéros.

**Script :**
- première réception sur plusieurs pages, puis passage vide ;
- reprise après une page en échec, sans trou ;
- retour à zéro sur changement d'adresse, d'identifiant, ou position > `max` ;
- 404 → ancienne réception, et nouvel essai au bout de 6 h ;
- un provisoire retiré par `unsold`, alors qu'un exact de la même enchère reste ;
- une vente Pro reçue avant son relevé, puis la date du relevé reçue ;
- plus de 8 000 cartes gardées en IndexedDB, et 8 000 au plus en mode secours ;
- `poolWant` muet quand le fil sert.
