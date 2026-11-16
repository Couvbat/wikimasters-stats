# Partager son historique Pro dans le fichier ami

## Pourquoi

Quand on importe le fichier d'un ami, on veut que les prix qu'il a déjà relevés remplissent nos propres tableaux (Collection, À vendre, Souhaits, pastilles). Aujourd'hui, le fichier ne transporte que les prix observés. L'historique Pro, qui est le plus complet, est exclu exprès. Jules veut pouvoir le partager.

## Ce qu'on fait

- **Export** (« Exporter pour mes amis ») : le fichier gagne un champ `pro`. Il contient les relevés Pro non vides, les plus récents d'abord, 8000 cartes au plus, au format compact `[carte, date du relevé, [[prix, date de vente], …], origine]`.
- **Tes ventes et achats** partent aussi, comme prix finaux exacts dans `seen.sales`. Seulement dans le fichier ami, pas dans la sauvegarde, qui les a déjà.
- **Import** : chaque relevé va dans `db.prices`. Pour chaque carte, on garde le plus récent, comme pour une sauvegarde. Une date dans le futur est ramenée à maintenant, pour qu'un fichier ne puisse pas figer ses prix. Le relevé garde son origine dans `by` (le pseudo de l'ami, ou celui de l'auteur d'origine s'il l'a lui-même reçu d'un ami).
- **Survol** : la fiabilité (tableaux) et la bulle des pastilles indiquent « relevé partagé par X ».
- **Place** : si le navigateur manque de place après l'ajout des prix Pro, on annule ces prix seulement, et on le dit. L'ami et ses prix observés restent importés.
- La taille maximale du fichier ami à l'import passe de 5 à 20 Mo.
- La sauvegarde garde l'origine `by` des prix quand elle les fusionne.
- README et version (1.19.0) mis à jour.

## Hors champ

- Pas de stock séparé par ami : retirer un ami ne retire pas ses prix (déjà le cas pour les prix observés).
- Les relevés « aucune vente » ne sont pas partagés (le site en renvoie parfois à tort pour L, UR, SR).
- Pas de boosters ni d'échanges de l'ami.

## Approches envisagées

- **A. Mélanger dans `db.prices` (choisie)** : les tableaux se remplissent sans toucher au calcul de la valeur. Un compte Pro ne redemande pas au site une carte relevée par l'ami il y a moins de 24 h.
- **B. Stock séparé par ami** : retirer un ami efface ses prix, mais c'est un stock de plus dans un `localStorage` limité, et le même prix est rangé en double.

## Laissé à l'implémentation

Noms des fonctions, et texte exact des messages et des bulles.
