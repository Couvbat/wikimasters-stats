# Données rangées carte par carte (phase 2 de l'audit) — design

Script 1.32.0. Suite de la 1.31.0 (enregistrement par rafale, prix gardés d'un dessin à l'autre) et de la 1.31.1 (enregistrement tout de suite à la fin d'un relevé et d'une réception du pool). Approche choisie par Jules le 25 novembre 2026 (« Yes, both »).

## Pourquoi

Mesures du 25 novembre dans le Chrome de Jules, une fois tout le pool reçu :

- Données communes : 13,2 Mo dans une seule entrée IndexedDB (`wmstats.v1`). Il y a `prices` (9,1 Mo, les historiques reçus du pool), `obsSales` (3,9 Mo, 16 679 cartes) et tout le reste (41 Ko).
- Mise en texte de l'ensemble : 20 à 27 ms. Écriture : environ 25 ms.
- Chrome ne finit pas une écriture IndexedDB commencée quand la page se ferme ou se recharge, même de quelques octets. C'est vérifié sur une page d'essai, dans `pagehide`, avec ou sans microtâche.

Depuis la 1.31, pour ne pas payer ces 50 ms à chaque changement, un enregistrement attend jusqu'à 5 secondes. La 1.31.1 enregistre tout de suite à la fin des relevés et des réceptions du pool. Mais ce que le script lit pendant qu'on navigue sur le site (marché, collection, fiches du site…) reste jusqu'à 5 secondes en attente : recharger la page pendant ce temps le perd.

**But :** qu'un enregistrement ne coûte que ce qui a changé (une carte : environ 1 ms), pour revenir à un enregistrement immédiat et garder ce coût constant quand le pool grossit.

Ranger en petits morceaux ne rend pas fiable l'écriture à la fermeture de la page (Chrome l'abandonne quelle que soit la taille). Le gain vient de ce que l'on peut de nouveau écrire tout de suite.

## Buts, non-buts, anti-buts

Buts :
- Chaque carte de `prices`, `obsSales` et `hist` a sa propre entrée IndexedDB. Un enregistrement n'écrit que :
  - les cartes qui ont changé ;
  - le reste des données communes (environ 40 Ko) ;
  - la partie personnelle du compte, comme aujourd'hui.
- Retour à l'enregistrement immédiat. Les appels d'une même tâche sont regroupés en une écriture, comme avant la 1.31, sans l'attente de 5 secondes.
- Passage automatique et sans perte au nouveau rangement, y compris si Jules revient un temps à une version plus ancienne.

Non-buts :
- Le mode localStorage (secours quand IndexedDB est bloqué, 5 Mo) ne change pas.
- La partie personnelle (`wmstats.v1.u.<compte>`) reste une entrée par compte.
- Ne changent pas non plus : `db` en mémoire, les sauvegardes exportées et importées, et les échanges avec le pool.
- Pas d'écriture garantie à la fermeture de la page.

Anti-buts (un échec, même si le reste marche) :
- Perdre des ventes : passage interrompu, ancien onglet resté ouvert, carte modifiée sans que l'enregistrement le voie.
- Ralentir visiblement l'ouverture des pages du site.
- Qu'un enregistrement dans un onglet fasse relire toute la base aux autres onglets.

## Approches

1. **Une entrée par carte (choisie).**
   - Mesuré sur les vraies données : 26 696 entrées, médiane 105 caractères, la plus grosse 11 Ko.
   - Écrire 3 cartes : 1 ms.
   - Tout relire au chargement : 130 à 150 ms, plus 35 ms de lecture JSON. Aujourd'hui : une lecture de 13 Mo et environ 20 ms de lecture JSON.
   - Premier passage au nouveau rangement : 0,8 s, une seule fois.
2. **Groupes d'environ 50 cartes.** Le chargement est plus rapide (environ 500 entrées). Mais une réception du pool qui touche quelques centaines de cartes réécrit un tiers à la moitié des groupes (4 à 7 Mo). C'est la solution de repli si le chargement de l'approche 1 se voit sur le site.
3. **Une entrée par section** (`prices`, `obsSales`, `hist`). Écartée : chaque réception du pool réécrirait 3,9 Mo, et chaque historique reçu les 9,1 Mo de `prices`.

## Design

**Clés.**
- `wmstats.v1.p.<carte>` : `db.prices[carte]`.
- `wmstats.v1.o.<carte>` : `db.obsSales[carte]`.
- `wmstats.v1.h.<carte>` : `db.hist[carte]`.
- Les identifiants de carte passent déjà par `okKey` (80 caractères au plus, ni `__proto__` ni ses semblables).
- `wmstats.v1` garde tout le reste. Il garde aussi `prices`, `obsSales` et `hist` sous forme d'objets vides : `loadDb` n'accepte `wmstats.v1` que si `prices` est un objet, et une version plus ancienne y relit ces trois sections.

**Chargement (mode `idb`).**
- `idbReadAll` lit déjà toutes les clés. `loadDb` reconstruit les trois sections à partir des entrées par carte.
- Si `wmstats.v1` contient encore des cartes dans ces sections (avant le premier passage, ou écrites par une version plus ancienne), elles sont fusionnées carte par carte :
  - `obsSales` : union par `keepAll` ;
  - `prices` : l'enregistrement le plus récent (`at`), avec l'union des ventes par `keepAll` ;
  - `hist` : le plus récent (`at`).
- Le premier enregistrement qui suit écrit les entrées par carte et vide ces sections dans `wmstats.v1`. Comme c'est une fusion, la répéter ne change rien, et aucun marqueur n'est nécessaire.

**Enregistrement.**
- Pour chaque carte des trois sections, une signature est comparée à celle de la dernière écriture. C'est la même idée que `priceSig` de la 1.31 :
  - `o` : la liste et sa longueur ;
  - `p` : l'objet, sa liste de ventes, sa longueur, `at`, `by` et `ats` ;
  - `h` : l'objet.
- Une carte nouvelle ou changée est écrite. Une carte disparue (plafond de `obsCardsMax`, `dropProvisional`, import) est effacée.
- Tout part dans une seule transaction, avec `wmstats.v1` et la partie personnelle, par la file `store.pending` existante.
- `saveDb` regroupe de nouveau les appels d'une même tâche (microtâche) et n'attend plus 5 secondes. `saveNow` reste pour le changement de compte, la fin des relevés et `store.idle`.

**Filet de sécurité.**
- Toutes les 10 minutes (`minuteTick`), chaque carte est mise en texte et comparée au texte gardé (`store.texts`). Les différences sont écrites.
- Cela rattrape une liste modifiée sur place, sans que sa signature change, par du code futur. Coût : environ 30 ms toutes les 10 minutes.

**Autres onglets.**
- Le message de fin d'écriture donne la liste des clés écrites.
- L'onglet qui le reçoit ne relit que ces clés (plus `wmstats.v1` et sa partie personnelle si elles en font partie), pas toute la base. Les règles actuelles de rechargement s'appliquent : pas pendant un relevé ni avec des écritures en attente.
- Reconstruire `db` à partir du cache coûte environ 35 ms. C'est fait au plus une fois par seconde.

**Inchangé :** le mode localStorage, `trimHistory` (mode localStorage seulement), `backupData` et `mergeBackup` (ils travaillent sur `db`), le pool, `storeLine` (la taille additionne toutes les clés), `accountLine` (elle compte les clés `.u.`).

## Ce qui le prouve (tests)

- Une seule carte changée : l'enregistrement n'écrit que son entrée, `wmstats.v1` et la partie personnelle.
- Passage : un `wmstats.v1` d'avant (avec les trois sections) donne des entrées par carte après chargement et enregistrement, et ses sections sont vides. Un rechargement redonne le même `db`.
- Retour d'une ancienne version : des cartes réécrites dans `wmstats.v1` après le passage sont fusionnées, sans rien perdre.
- Une carte retirée de `obsSales` voit son entrée effacée.
- Une liste modifiée sur place sans changer de longueur est écrite par le filet de sécurité, dans les 10 minutes (horloge simulée).
- Deux onglets : une carte changée dans A arrive dans B sans relecture complète de la base (lectures comptées).
- Les tests existants du mode localStorage passent sans changement.
- Mesures :
  - avec le banc d'essai des 1.31, coût et volume écrit par carte relevée ;
  - dans un vrai navigateur avec environ 27 000 entrées, temps de chargement ;
  - sur le site après installation, ouverture des pages.

## Laissé au constructeur

- Le détail des signatures et du format du message entre onglets.
- La forme exacte du regroupement (microtâche ou court délai).
- Bascule vers les groupes de 50 cartes (approche 2) si, sur le site, le chargement retarde visiblement l'apparition des pastilles. Cette décision se prend sur mesure et se note dans la PR.
