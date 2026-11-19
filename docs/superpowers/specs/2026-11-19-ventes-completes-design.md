# Toutes les ventes, valeur récente et depuis toujours — conception

## Pourquoi

Jules veut des prix meilleurs. Les plafonds de ventes gardées venaient de la limite de 5 Mo de l'ancien stockage : avec IndexedDB (1.24), ils n'ont plus lieu d'être.

Plus de ventes donne une médiane plus stable, surtout pour les cartes qui se vendent peu. Mais une médiane sur toute l'histoire retarde quand le marché bouge. Jules veut donc voir **les deux** : la valeur **depuis toujours** et la valeur **récente**.

Plafonds actuels :

| Endroit | Plafond |
|---|---|
| Script, historique Pro et prix observés | 20 ventes par rareté pour L/UR/SR, 10 sinon, 60 par carte (`keepPerRarity`) |
| Relevé Pro | **remplace** le précédent (`ingestSales`, et `mergePro` pour le pool et les fichiers ami : le plus récent gagne) ; rien ne s'accumule |
| Pool, réponse | 20 ventes par rareté, 60 par carte (`pullCards`) |
| Pool, envoi | 50 ventes par relevé Pro (`LIMITS.proSales`) |

Le pool, lui, garde déjà tout.

## Décisions de Jules

- **La valeur qui compte** dans les totaux, les bonnes affaires et l'enchère max : **la récente quand il y a assez de ventes, sinon celle depuis toujours.** Les deux s'affichent.
- **Approche : garder et faire circuler toutes les ventes**, plutôt que des résumés calculés par le pool, ou des plafonds simplement relevés.

## Objectifs

- Garder toutes les ventes connues de chaque carte, et faire s'accumuler les relevés Pro au fil du temps.
- Faire circuler toutes les ventes par le pool, dans les deux sens.
- Calculer et afficher une valeur récente et une valeur depuis toujours, la première comptant quand elle repose sur assez de ventes.

## Hors sujet

- Des résumés calculés par le serveur : on y passera si le volume explose.
- Changer la fiabilité, la tendance ou les seuils des bonnes affaires (30 %, 3 ventes).
- Une fenêtre récente réglable : elle est fixe.

## À éviter absolument

- Compter deux fois la même vente : même rareté, même date, même prix, ou même enchère.
- Faire sauter la limite de corps du pool (2 Mo) avec des envois d'historiques entiers.
- Revenir à des prix faux en mode secours (`localStorage`, limité à 5 Mo) : le garde-fou qui raccourcit l'historique y reste.

## Approches envisagées

1. **Toutes les ventes, partout (retenue par Jules).** Plus de plafond par rareté, avec un garde-fou très haut contre un emballement. Le calcul reste le même, sur des ventes complètes. Le pool entier fait aujourd'hui 51 000 ventes, soit environ 3 Mo.
2. **Des résumés calculés par le pool** (médianes par carte, rareté et période). C'est léger à toute échelle, mais il y aurait deux façons de calculer un prix, et sans pool la valeur « depuis toujours » ne serait plus complète. Écartée pour l'instant.
3. **Des plafonds relevés** (par exemple 200 par rareté). On garderait une limite arbitraire. Écartée.

## Conception

### Garder toutes les ventes (script)

- **`keepAll(list)`** remplace `keepPerRarity` dans l'usage normal :
  - toutes les ventes, de la plus récente à la plus ancienne ;
  - dédoublonnées par `(rareté, date, prix)` ;
  - avec un garde-fou de **2 000 ventes par carte** (`MAX_SALES_PER_CARD`), qui garde les plus récentes.
- `keepPerRarity` ne sert plus qu'à `trimHistory`, le garde-fou du mode secours.
- **Relevé Pro** (`ingestSales`) : les ventes lues **s'ajoutent** à celles déjà connues de la carte (union dédoublonnée) ; `at` devient la date du relevé. Une relecture vide ne change rien, comme aujourd'hui.
- **`mergePro`** (pool, fichiers ami) : union des ventes au lieu de « le plus récent gagne ». `at` = la date la plus récente, et `by` = l'auteur du relevé le plus récent. Il est vide quand c'est toi.
- **Prix observés** (`addObserved`) et **tes ventes** (`mySales`) : `keepAll`.

### Faire circuler toutes les ventes (pool)

- **Serveur 1.3.0** : `pullCards` renvoie **toutes** les ventes Pro et observées de chaque carte, 2 000 au plus de chaque sorte, les plus récentes d'abord. C'est la même chose dans les deux requêtes, sans `rn <= 20` ni `LIMIT 60`.
- **Envoi** : un relevé Pro en file envoie les **200 ventes les plus récentes** de la carte, soit autant qu'un relevé du site. Le serveur garde déjà les plus anciennes, envoyées par les relevés précédents. `LIMITS.proSales` passe à 200.
- **Taille des lots** : `poolFlush` arrête un lot quand son texte JSON dépasserait **1,5 Mo**, sous la limite de 2 Mo du serveur. Le reste part au lot suivant.

### Valeur récente et depuis toujours (calcul)

Constantes : `RECENT_DAYS = 7`, `RECENT_MIN = 3`.

`priceOf(cardId, rarity)` choisit la source et la rareté comme aujourd'hui, puis calcule sur ses ventes :
- **depuis toujours** : `medAll`, `nAll`, sur toutes les ventes ;
- **récente** : `medRecent`, `nRecent`, sur les ventes des 7 derniers jours ;
- **la valeur qui compte** (`med`, `n`, `sales`, `rel`) : la récente si `nRecent >= 3`, sinon celle depuis toujours. `basis` vaut `'recent'` ou `'all'`.
- `avg`, `min`, `max`, `last`, `rel` et `trend` sont calculés sur l'ensemble retenu. Les autres fonctions (`valueOf`, `dealPct`, `maxBid`) ne changent pas : elles lisent `med` et `n`.

### Affichage

- **Onglet Collection** :
  - la colonne « Valeur » montre la valeur qui compte, suivie d'une petite marque « 7 j » quand c'est la récente ;
  - deux nouvelles colonnes, « 7 jours » et « Depuis toujours », montrent chacune leur médiane et leur nombre de ventes (« 1 200 ₩ · 5 ventes »), ou « — » sans vente.
- **Bulle des pastilles** : la ligne « Valeur médiane » dit sur quoi elle repose, et une ligne de plus donne l'autre valeur. Par exemple : « Valeur : 1 200 ₩ (7 derniers jours, 5 ventes) » et « Depuis toujours : 1 450 ₩ (84 ventes) ».
- **Onglet Souhaits** : la bulle de la colonne « Valeur médiane » donne les deux valeurs de la même façon.

## Tests

- `keepAll` : dédoublonnage par `(rareté, date, prix)` ; tri du plus récent au plus ancien ; 2 001 ventes deviennent 2 000.
- **Relevés Pro qui s'accumulent** : deux relevés de 3 ventes, dont 1 en commun, donnent 5 ventes ; une relecture vide ne change rien.
- `mergePro` : l'union, avec `by` de l'auteur le plus récent.
- `priceOf` :
  - 4 ventes dans les 7 jours à 100 et 30 ventes plus anciennes à 300 donnent `med` = 100, `basis` = `'recent'`, `nRecent` = 4, `medAll` = 300 ;
  - avec 2 ventes récentes seulement, `med` = la médiane de tout, `basis` = `'all'`.
- **Serveur** : `pullCards` renvoie 75 ventes Pro et 75 observées d'une même rareté (plus de 20) ; 2 500 en donnent 2 000.
- **Envoi** : un relevé Pro de 500 ventes envoie les 200 plus récentes ; un lot dont le JSON dépasserait 1,5 Mo est coupé en deux envois.
- **Mode secours** : `trimHistory` raccourcit toujours à 10 ventes par rareté.

## Livraison

Script 1.27.0 et serveur 1.3.0. La branche part de `claude/amis-pool` (PR #14), puisqu'elle touche les mêmes fichiers. Elle sera rebasée sur `main` dès la fusion de la #14. Après la fusion, il faudra mettre à jour le serveur du NAS, avec la même méthode. README, section « Prix observés » et lecture des chiffres : les deux valeurs et la règle des 7 jours.

## Décisions prises par Claude (à vérifier)

- **Fenêtre récente de 7 jours, et 3 ventes minimum** pour qu'elle compte.
- **Garde-fou de 2 000 ventes par carte**, partout (script et réponses du pool).
- **Un envoi de relevé Pro = les 200 ventes les plus récentes**, et des lots de 1,5 Mo au plus.
- **Où afficher les deux valeurs** : deux colonnes dans Collection, plus les bulles des pastilles et des Souhaits.
- **La fiabilité et la tendance** sont calculées sur l'ensemble retenu : récent ou depuis toujours.
