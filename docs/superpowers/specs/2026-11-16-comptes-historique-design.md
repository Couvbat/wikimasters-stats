# Plusieurs comptes dans un navigateur, et un historique plus long — conception (courte)

## Pourquoi

- **Comptes mélangés.** Jules utilise deux comptes WikiMasters (Pro et normal) dans le même Chrome. Toutes les données du script étaient rangées sous une seule clé du navigateur : changer de compte mélangeait les collections, les ventes, les échanges et le reste.
- **Historique trop court.** Jules veut garder plus de ventes pour affiner les prix. Le navigateur n'offre qu'environ 5 Mo, partagés avec le site, et le pool garde déjà tout l'historique.

## Ce qu'on fait

### Données par compte (approuvé par Jules)

- **Propres à chaque compte** :
  - collection (`cards`, `collectionAt`, `collectionFullAt`) ;
  - boosters (`pulls`) ;
  - ventes et achats (`mySales`, `auctions`) ;
  - évolution (`history`) ;
  - souhaits (`wish`, `wishAt`, `alerts`, `wishSeen`, `wishHideOwned`) ;
  - échanges (`trades`, `tradesAt`) ;
  - enchères en cours (`bids`, `bidsAt`) ;
  - amis, pseudo, réglages de vente (`friends`, `me`, `sell`) ;
  - tes annonces et tes places de vente (`market.selling`, `market.max`).
- **Communes à tous les comptes du navigateur** :
  - les prix (`prices`, `obsSales`, `obsRar`) ;
  - les enchères suivies et l'état du marché (`obs`, `finQ`, `market.asks`, `market.at`) ;
  - les réglages d'affichage (`ov`, `overlay`, `autoPull`) ;
  - le pool, le relevé automatique et la mise à jour ;
  - le compte connecté (`userId`) et son statut Pro.
- **Rangement** : la clé `wmstats.v1` garde la partie commune, et la clé `wmstats.v1.u.<identifiant du compte>` la partie personnelle. Tant que le compte n'est pas reconnu, la partie personnelle est sous `wmstats.v1.u._`.
- **Détection** : `ingestPro` (le profil du compte connecté, lu au chargement de la page) et `ingestCollection` (le `user_id` des cartes) appellent `setAccount(uid)`.
  - Compte pas encore connu : il hérite des données présentes.
  - Autre compte : la partie personnelle de l'ancien est enregistrée, celle du nouveau est chargée (vide si c'est la première fois).
  - `ingestCollection` change de compte **avant** de vider la collection.
- **Migration** : l'ancienne clé unique contient encore la partie personnelle. Elle est chargée telle quelle, puis répartie au premier enregistrement. Rien n'est perdu.
- **Réglages** : une ligne « Compte : … » et le bouton **« Effacer les données de ce compte »**. Il faut le confirmer par un second clic dans les 5 s. Il ne vide que la partie personnelle du compte connecté.
- **Enregistrement** : la partie personnelle est écrite d'abord. Si elle ne tient pas, rien n'est modifié.

### Historique plus long (choix de Claude, accepté par Jules)

- `keepPerRarity` garde **20 ventes par rareté pour L, UR et SR**, 10 pour les autres, 60 au plus par carte.
- La valeur est la médiane des ventes gardées à la bonne rareté.
- Le serveur du pool renvoie 20 ventes par rareté, 60 au plus.
- **Garde-fou** : si l'enregistrement échoue faute de place, on vide d'abord le relevé du marché (comme avant). Si ça ne suffit pas, on ramène l'historique à 10 ventes par rareté, puis on réessaie.

## Hors champ

- La séparation des files du pool par compte : la file reste commune, et c'est le pseudo du compte connecté qui signe l'envoi.
