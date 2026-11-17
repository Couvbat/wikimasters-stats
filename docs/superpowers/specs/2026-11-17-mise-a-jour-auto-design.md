# Mise à jour automatique — conception

## Pourquoi

Jules veut garder à jour, sans cliquer bouton après bouton, **la valeur de sa collection** et **les prix de ses cartes souhaitées**. Le reste peut rester manuel. Le vrai frein, c'est le volume : « Relever les prix » relit chaque carte dont le prix a plus de 24 h, une par seconde. Avec plus de 3 600 cartes à prix, ça fait plus d'une heure par jour, et ça grossit.

Aujourd'hui, il faut cliquer « Recharger ma collection », puis « Relever les prix » (Pro), puis « Recharger ma liste », « Vérifier les alertes » ou « Trouver les annonces », et enfin « Relever les valeurs » (Pro). Seule la case « Relever les prix en arrière-plan » (`autoObs`) tourne toute seule : au plus toutes les 30 min, un onglet visible relève 60 prix finaux, puis lit les fins d'enchères.

## Objectifs

- Une **routine automatique** qui fait ces étapes toute seule, par petits passages, dans un ordre de priorité.
- Relire les prix **selon ce que chaque carte pèse dans la valeur**, et non plus toutes les cartes chaque jour.
- Un bouton **« Tout mettre à jour maintenant »** qui lance la même routine sans attendre, au rythme des boutons actuels.
- Rester prudent vis-à-vis de la détection d'automatisation du site.

## Hors sujet

- Automatiser le reste : échanges, concurrence de « À vendre », mes enchères, boosters.
- Écrire quoi que ce soit sur le site : la routine ne fait que lire, comme le reste du script.
- Changer la façon dont la valeur est calculée (`priceOf`, `valueOf`).

## À éviter absolument

- Déclencher le blocage du site (`automation_limit`) plus souvent qu'avant. La routine reste au rythme prudent d'aujourd'hui ; seul le bouton va plus vite, à la demande de Jules.
- Deux onglets qui lisent le site en même temps.
- Une collection rechargée à moitié : `ingestCollection(…, true)` retirerait les cartes des pages non lues.

## Approches envisagées

1. **Une seule routine, plus le bouton (retenue par Jules).** La case `autoObs` devient « Mise à jour automatique ». Chaque passage enchaîne les étapes par priorité, avec un budget de requêtes, sur le mécanisme actuel : verrou entre onglets, pause de 24 h, attente de 2 min après l'ouverture. Le bouton lance la même routine sans budget.
2. **Une minuterie par tâche** (collection, prix, souhaits). Écartée : elles pourraient lire le site en même temps et additionner leurs requêtes.
3. **Seulement le bouton.** Écartée comme solution unique : il faut encore y penser. Gardée en complément.

## Conception

### Quand relire le prix d'une carte : `priceDue(cardId, rarity)`

Elle remplace `priceStale(cardId, rarity)` partout : `missingIds`, donc le bouton « Relever les prix », `wishPricesToFetch` et la routine. Une carte est **à relire** quand l'âge de son prix (`now - db.prices[id].at`) dépasse son délai :

| Carte | Délai |
|---|---|
| valeur connue **> 50 ₩** (choix de Jules) | 1 jour |
| L, UR | 1 jour |
| en vente (`db.selling`) | 1 jour |
| SR | 2 jours |
| R | 4 jours |
| PC, C, rareté inconnue | 7 jours |

- Sans prix (`db.prices[id]` absent) : à relire tout de suite.
- On garde le cas actuel des historiques vides douteux : rareté de `DOUBT_EMPTY` et âge de plus d'une heure.
- La « valeur connue » est la médiane de `priceOf(cardId, rarity)` quand `n > 0`.

### Dans quel ordre : le poids

Les cartes à relire passent de la plus lourde à la plus légère :

- **poids** = valeur × nombre d'exemplaires possédés ;
- **valeur** = valeur connue, sinon la médiane des valeurs connues de la même rareté dans la collection, sinon 1 ;
- pour un souhait en vente, le nombre d'exemplaires compte pour 1.

S'il reste peu de budget, ce sont donc les cartes qui comptent le plus dans le total qui sont relues.

### Un passage de la routine

Il se déclenche au plus toutes les 30 min, quand la case est cochée. Il faut que les données soient chargées (1.24), qu'aucun bouton ne tourne (`job.running`), qu'on ne soit pas en pause après `automation_limit`, que la page soit ouverte depuis 2 min, et qu'aucun autre onglet n'ait le verrou.

**Changement :** la routine tourne aussi quand l'onglet est en arrière-plan. Le navigateur ralentit alors ses minuteries, ce qui la ralentit d'autant.

Budget : **60 requêtes au site par passage** (`AUTO_BUDGET`, à la place de `AUTO_MAX`). Les étapes, dans l'ordre :

1. **Collection, une fois par jour.** Si `db.collectionFullAt` a plus de 24 h, la collection est relue en entier, comme « Recharger ma collection ». La relecture va jusqu'au bout, même au-delà du budget : une collection relue à moitié est pire que pas relue. Si elle est interrompue (bouton lancé, Stop, erreur), rien n'est remplacé. Après une relecture complète, le passage s'arrête là.
2. **Liste de souhaits, une fois par jour.** Si `db.wishFullAt` a plus de 24 h, elle est relue en entier, comme `loadWish`. C'est un nouveau champ personnel, posé seulement par une relecture complète (`ingestWish(…, true)`) : `db.wishAt` change aussi quand le site affiche une seule page de la liste. Comme pour la collection, la liste n'est remplacée que si la lecture est complète.
3. **Alertes du site** : les souhaits signalés en vente (`alertsToCheck()`), cherchés sur le marché comme « Vérifier les alertes ». 20 au plus par passage.
4. **Prix**, dans le budget restant :
   1. le pool d'abord, s'il est activé : `poolPrefetch` pour toutes les cartes à relire (requêtes au pool, pas au site), puis `priceDue` à nouveau ;
   2. compte Pro : `fetchSales` pour les cartes encore à relire, triées par poids. Ce sont les cartes de la collection, plus les souhaits en vente (`askOf`), dans une seule liste ;
   3. compte non Pro : pas de lecture d'historique, les prix viennent du pool et des enchères observées.
5. **Prix finaux et fins d'enchères**, comme aujourd'hui (`finalsToFetch`, puis la lecture `ending_soon`), dans ce qui reste du budget.

Le rythme reste celui d'aujourd'hui : une requête toutes les 1 à 1,5 s (`autoSleep`).

### Le verrou entre onglets

Aujourd'hui, `wmstats.auto.until` est calculé une fois au début du passage. En arrière-plan, un passage peut durer bien plus longtemps, et un autre onglet le croirait fini. Le verrou est donc **renouvelé à chaque requête**, pour 2 min (`until = now + 2 min`). À la fin du passage, `until = 0` et `at = maintenant`.

### Le bouton « Tout mettre à jour maintenant »

- Il est dans l'onglet Accueil, en haut, et dans le groupe « Mise à jour automatique » des Réglages.
- Il lance la même routine comme un relevé manuel (`startJob`) : progression affichée, bouton Stop, au rythme des boutons (`pace()`, une requête par seconde).
- Il n'a **pas de budget**, n'attend pas 30 min, et fait les étapes 1 à 5 jusqu'au bout. La collection et la liste ne sont relues que si elles ont plus de 24 h, sinon c'est le bouton dédié qui le fait.
- Il marche que la case soit cochée ou non.
- `automation_limit` l'arrête, avec le message actuel.

### Ce que Jules voit

- **Réglages** : la case « Relever les prix en arrière-plan » devient **« Mise à jour automatique »**. Même clé `autoObs` : ceux qui l'avaient cochée la gardent. Elle reste décochée par défaut. Sa bulle décrit les étapes ci-dessus.
- **Ligne d'état**, dans l'Accueil sous le bouton et dans les Réglages : « Dernière mise à jour automatique : il y a 12 min · 34 prix relus, 5 annonces vérifiées, 18 prix finaux. Encore 420 cartes à relire. » Le dernier chiffre est le nombre de cartes de la collection et de souhaits en vente que `priceDue` donne à relire. Pour un compte non Pro, il n'apparaît pas.
- `db.autoLast` garde `{ at, prices, alerts, finals, collection: bool, wish: bool }`.

## Tests

À ajouter dans `test/mise-a-jour-auto.test.js`, avec le harnais actuel et son faux `fetch` :

- **`priceDue`** :
  - les délais du tableau, valeur > 50 comprise, une carte en vente à 1 jour, une carte sans prix ;
  - un historique vide d'une L est à relire après une heure.
- **Ordre** : par poids (valeur × exemplaires), avec la médiane de la rareté pour une carte sans prix.
- **Un passage (Pro)** :
  - il respecte le budget de 60 ;
  - les cartes les plus lourdes passent d'abord ;
  - les alertes sont limitées à 20 ;
  - le pool est consulté avant le site.
- **Collection de plus de 24 h** : relue en entier, puis le passage s'arrête. Une erreur au milieu ne remplace rien.
- **Liste de souhaits de plus de 24 h** : relue.
- **Compte non Pro** : aucune requête `/sales`.
- **`automation_limit`** pendant un passage : arrêt, et pause de 24 h.
- **Verrou** : renouvelé à chaque requête ; un autre onglet qui le détient bloque le passage.
- **Onglet en arrière-plan** : le passage a lieu.
- **Bouton** : pas de budget, toutes les cartes à relire le sont, et Stop arrête.
- **« Relever les prix »** suit `priceDue` : une C relue il y a 3 jours n'est plus relue.

## Livraison

Version 1.25.0, construite sur la 1.24.0 (PR #11, IndexedDB), puisque la routine accumule encore plus de données. README : section « Prix observés » et Réglages (la case et le bouton). GUIDE.md : une phrase pour tes potes, « coche Mise à jour automatique dans les Réglages ».

## Décisions prises par Claude (à vérifier)

- **Délais hors du seuil de Jules :** SR 2 jours, R 4 jours, C et PC 7 jours, L et UR 1 jour même sous 50 ₩. Proposés, et Jules n'a pas objecté.
- **« Relever les prix » et « Relever les valeurs » suivent aussi `priceDue`,** pour que le clic soit plus court lui aussi.
- **Budget de 60 requêtes par passage, toutes les 30 min, comme aujourd'hui** : le rythme prudent. La collection et la liste, une fois par jour, peuvent le dépasser pour être relues en entier.
- **La routine tourne aussi en arrière-plan.**
- **20 alertes au plus par passage.**
- **Le bouton ne relit la collection et la liste que si elles ont plus de 24 h.** Pour forcer, les boutons dédiés restent.
- **Même clé `autoObs`,** pour ne pas décocher la case de ceux qui l'avaient activée.
