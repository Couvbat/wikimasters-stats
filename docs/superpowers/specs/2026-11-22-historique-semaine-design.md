# Historique par semaine et relevé pour tous — conception

Script 1.30.0, script seul : le serveur du pool ne change pas. Ce chantier part de la 1.29.1 (relevé des ventes à la rareté de la carte, date de relevé par rareté).

## Pourquoi

wiki-masters.com a été mis à jour en novembre 2026.
- **Les comptes non Pro ont maintenant accès au marché et à ses données.** Un ami non Pro de Jules voit la « Vue du marché » d'une carte. Le script réserve pourtant encore le relevé des ventes aux comptes Pro.
- **L'historique des ventes d'une carte se limite aux 5 dernières ventes**, filtrables par rareté. La longue liste de 200 ventes a disparu. La fiche par carte (1.29.0) manque donc de ventes pour ses repères.
- **Le site donne un historique des prix par semaine** : `GET /api/marketplace/cards/<id>/price-history`, appelé par sa Vue du marché. Il porte sur toutes les ventes du marché, pas seulement celles que le groupe connaît. Exemple de réponse :
  ```
  { "by_rarity": { "C": { "weekly":  [{ "start": "2026-11-16", "avg": 103, "min": 11, "max": 226, "count": 16 }, …],
                          "monthly": [{ "start": "2026-08-01", "avg": 13, "min": 13, "max": 13, "count": 1 }, …] } },
    "computed_at": "2026-11-22T13:40:00.056218+00:00" }
  ```
  Environ 12 semaines et 4 mois, une entrée par rareté qui a des ventes. Les semaines commencent le lundi. Ce sont des **moyennes** : la valeur du script, elle, est une **médiane** des ventes.

## Décisions de Jules

- **Relevé pour tous.** « Relever les prix » marche pour tout compte reconnu, Pro ou non.
- **L'historique par semaine est enregistré quand le site le charge**, c'est-à-dire quand Jules ouvre la Vue du marché d'une carte. Les relevés automatiques ne font aucune requête en plus.
- **Il sert à la fiche** : rythme, repli du prix du moment et du sens, courbe. Il sert aussi à la ligne « Repères » de la bulle.

## Objectifs

- Supprimer le blocage Pro de tous les relevés de ventes et des textes qui l'annoncent.
- Enregistrer l'historique par semaine de chaque carte et de chaque rareté vues.
- Dans la fiche :
  - le rythme réel du marché ;
  - un repli sur les moyennes du site quand les ventes connues ne suffisent pas au prix du moment ou au sens ;
  - les moyennes par semaine sur la courbe.

## Hors sujet

- Changer la valeur, la fiabilité, les bonnes affaires ou l'enchère max. Elles restent fondées sur les ventes, pas sur des moyennes.
- Partager l'historique par semaine par le pool : il faudrait changer le serveur.
- Demander l'historique lors des relevés automatiques (« Relever les prix », mise à jour automatique, boosters, enchères, échanges, souhaits).
- Utiliser l'historique par mois.

## À éviter absolument

- **Une requête au site sans clic de Jules.** Seul le bouton de la fiche demande l'historique, sur clic.
- **Un repère qui contredit la valeur.** Les ventes passent d'abord ; l'historique ne sert que de repli, et la fiche dit quand elle s'en sert.
- **Un blocage pour un compte non Pro**, ou un texte qui parle encore de « compte Pro uniquement ».

## Approches envisagées

1. **Enregistrer l'historique quand le site le charge (retenue par Jules).** Aucune requête en plus, mais l'historique n'existe que pour les cartes dont Jules a ouvert la Vue du marché ou cliqué le bouton de la fiche.
2. **Demander l'historique à chaque relevé.** Il serait toujours là, mais chaque carte coûterait deux requêtes au lieu d'une, sous la limite d'automatisation du site. Écartée.
3. **Laisser la courbe au site.** Aucun travail, mais la fiche garderait des repères pauvres maintenant que les relevés ne rapportent que 5 ventes. Écartée.

## Conception

### Relevé pour tous

- Une fonction `canFetchPrices()` remplace tous les tests `proState() === true` qui bloquent un relevé de ventes : vrai dès que le compte est reconnu (`db.userId`). Sont concernés :
  - « Relever les prix » ;
  - la mise à jour automatique ;
  - les prix des boosters ;
  - les prix de tes enchères ;
  - les prix des échanges ;
  - les prix des souhaits en vente ;
  - le bouton de la fiche.
- `showPrices()` montre aussi les prix dès que le compte est reconnu.
- `proState()` reste pour savoir si le compte est Pro, mais ne bloque plus rien.
- La pause de 24 h sur `automation_limit` ne change pas.
- **Textes :**
  - plus de « (Pro) » ni de « Compte Pro. » dans les boutons et les bulles ;
  - le message d'un booster dont le statut n'est pas encore détecté devient « Compte pas encore reconnu : recharge la page (F5) pour activer les prix. » ;
  - le README remplace « compte Pro uniquement » et réécrit la section « Compte non Pro ».

### Enregistrer l'historique

- **Interception.** Le crochet `fetch` du script reconnaît `GET /api/marketplace/cards/<id>/price-history` et appelle `ingestHistory(cardId, json)`.
- **Bouton de la fiche.** Il devient « Relever les ventes », pour tous les comptes. Il demande `/sales?rarity=<rareté>` puis `/price-history`, une seconde d'écart, et il ne passe que s'il n'y a pas d'autre traitement en cours.
- **Stockage**, dans `db.hist`, commun à tous les comptes comme les prix :
  ```
  db.hist[cardId] = { at: <computed_at en ms, sinon maintenant>, w: { <rareté>: [[début 'AAAA-MM-JJ', moyenne, min, max, ventes], …] } }
  ```
  - Seules les semaines sont gardées, triées de la plus ancienne à la plus récente.
  - Une semaine illisible est ignorée : début qui n'est pas une date, moyenne ≤ 0, nombre de ventes négatif.
  - Une réponse plus récente remplace l'ancienne pour chaque rareté qu'elle contient.
- **Limites.**
  - En IndexedDB : 3 000 cartes au plus. Au-delà, on retire les plus anciennes par `at`.
  - En mode secours (localStorage) : 200 cartes.
  - `trimHistory()`, quand le stockage est plein, vide `db.hist`.
- L'historique n'entre ni dans la sauvegarde ni dans le fichier ami : le site le redonne.

### Les repères avec l'historique

`cardCues(sales, now, asks, weeks)` reçoit en plus `weeks`, les semaines de la rareté affichée (`db.hist[id].w[rareté]`), ou `null`. Elle reste pure.

Définitions :
- une **semaine complète** est finie (début + 7 jours ≤ maintenant) ;
- la **semaine en cours** contient maintenant.

1. **Rythme.** S'il y a au moins une semaine complète, le rythme vient de l'historique.
   - Calcul : les ventes des 4 dernières semaines complètes (ou de toutes s'il y en a moins), ramenées à la semaine.
   - Textes :
     - « se vend environ N fois par semaine sur le marché » si c'est au moins 1 par semaine ;
     - sinon « se vend environ N fois par mois sur le marché », avec N le total des 4 semaines ;
     - « aucune vente en 4 semaines sur le marché » quand il n'y en a aucune.
   - « dernière vente il y a … » vient toujours des ventes connues. Sans historique, le rythme reste celui de la 1.29.
2. **Prix du moment.** Les ventes d'abord, comme en 1.29. Si elles ne suffisent pas (`few`), on compare l'historique :
   - la moyenne de la semaine en cours (3 ventes au moins) ;
   - face à la moyenne pondérée par les ventes des 4 semaines complètes d'avant (5 ventes au moins en tout) ;
   - avec les mêmes seuils de ±15 %.
   - Le texte ajoute « · cette semaine : X ₩ (N ventes), 4 semaines d’avant : Y ₩ (M ventes), moyennes du site ».
   - `moment.src` vaut `'sales'` ou `'hist'`.
3. **Sens.** Les ventes d'abord, comme en 1.29. Si elles ne suffisent pas (`few`), on prend la pente de Theil-Sen sur le logarithme des moyennes des 8 dernières semaines qui ont des ventes. Chaque semaine est placée à son milieu, soit début + 3,5 jours.
   - Il faut 4 semaines au moins, et une semaine en cours ne compte que si elle a 3 ventes au moins.
   - Les seuils restent à ±5 % par semaine.
   - Le texte ajoute « · moyennes du site », et `slope.src` vaut `'sales'` ou `'hist'`.
4. **Bulle.** `cuesOf` passe les semaines de la rareté évaluée. La signature du cache inclut `db.hist[id].at`.

### La courbe

`cardChart(points, marks, period, now, lines, weeks)` reçoit les semaines de la rareté affichée.
- Pour chaque semaine qui tombe dans la période :
  - une barre verticale du minimum au maximum, un `line` gris clair, sans pointillés, au milieu de la semaine ;
  - la moyenne, sur une ligne brisée (`polyline`) qui relie les moyennes des semaines.
- Pour « tout », l'axe des dates part de la plus ancienne vente, marque ou semaine.
- L'axe des prix est borné sur les ventes, les marques et les moyennes ; les minimums et maximums sont coupés aux bornes.
- Les segments de médiane du repère 1 ne sont dessinés que si `moment.src === 'sales'`.
- La légende ajoute : « ligne grise : moyenne par semaine du site, barres : son minimum et son maximum ».

### Ce qui ne change pas

La valeur, la fiabilité, les bonnes affaires, l'enchère max, le pool et le serveur.

## Laissé au développeur

- Le nom des fonctions internes, sauf `canFetchPrices`, `ingestHistory`, `cardCues` et `cardChart`, dont la forme est fixée ici.
- Les couleurs exactes, dans le style de la courbe actuelle.

## Tests attendus

- **Relevé pour tous.** Un compte non Pro reconnu relève les prix : « Relever les prix », mise à jour automatique, boosters, enchères. Un compte non reconnu ne relève rien.
- **Historique.**
  - Une réponse du site est enregistrée par rareté, et une semaine illisible est ignorée.
  - Une réponse plus récente remplace l'ancienne.
  - Le plafond de cartes est respecté.
  - Le bouton de la fiche demande les ventes puis l'historique.
- **Repères.**
  - Rythme tiré de l'historique : par semaine, par mois, aucune vente.
  - Repli du prix du moment, avec les minimums de 3 et 5 ventes.
  - Repli du sens, avec le minimum de 4 semaines.
  - Les ventes passent avant l'historique quand elles suffisent.
- **Courbe.** Les barres et la ligne des moyennes sont dessinées, sans casser les comptes de formes des tests de la 1.29.0, et les médianes sont absentes quand le prix du moment vient de l'historique.
- **Bulle.** Un historique reçu change la ligne « Repères ».
