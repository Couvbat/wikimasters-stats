# Prix par rareté — conception (courte)

## Pourquoi

Une même carte se vend à plusieurs raretés, parce que des exemplaires de raretés différentes circulent en même temps. Le script mélangeait toutes ces ventes dans une seule médiane, et toutes les annonces sous la même ligne. Résultat : des valeurs fausses, et de fausses « bonnes affaires ».

Constaté le 16/11 avec le compte Pro de Jules :
- une carte L avait 9 ventes en L, entre 12 101 et 15 000 ₩, et une vente UR à 7 088 ₩ ;
- une autre, sur 200 ventes, en comptait 189 en L, 8 en UR et 3 en SR.

Constaté par Jules dans les souhaits : une ligne L contenait des annonces UR, sans que leur rareté soit affichée.

## Faits vérifiés

- Une vente de l'historique Pro ressemble à `{ id, final_price, settled_at, rarity }`. La réponse contient `recent` (10 ventes) et `sales` (jusqu'à 200, depuis environ deux semaines).
- Une enchère du Marché porte `snapshot_rarity` (la rareté de l'exemplaire) et `card.rarity` (la rareté actuelle de la carte).

## Ce qu'on fait

1. **Chaque vente garde sa rareté (`r`)**, partout où on la connaît :
   - l'historique Pro, qui lit désormais `sales` (200 ventes) au lieu de `recent` ;
   - les prix provisoires et finaux observés ;
   - tes ventes et achats ;
   - le fichier ami, la sauvegarde et le pool.
2. **On garde 10 ventes par rareté** (40 au plus par carte), au lieu des 10 dernières toutes raretés confondues.
3. **La valeur se calcule par rareté** : `priceOf(carte, rareté)`.
   - Si la rareté n'est pas précisée, c'est celle de la carte : celle de ta collection, de tes souhaits, sinon celle vue sur le site.
   - Choix des ventes, dans cet ordre :
     1. les ventes à cette rareté ;
     2. sinon, les ventes à rareté inconnue (anciennes données) ;
     3. sinon, toutes les ventes, marquées « autres raretés » (notées « Douteux », et la bulle le dit).
   - Entre les sources (historique Pro, tes ventes, ventes observées), on prend la première qui a des ventes à la bonne rareté avant de se rabattre sur une source mélangée.
4. **Chaque annonce garde sa rareté.**
   - La ligne d'une carte présente d'abord les annonces à la rareté voulue.
   - Dépliée, chaque annonce porte son étiquette de rareté.
   - Bonne affaire, enchère max, marge, pastilles du Marché et « En vente à » comparent chaque annonce à la valeur **de sa propre rareté**.
5. **Formats** : la rareté de chaque vente est ajoutée en fin d'entrée.
   - Fichier ami et pool : `[[p, t, r], …]` pour l'historique Pro, et `[…, r]` pour les ventes observées.
   - Le serveur du pool garde la rareté de chaque vente et renvoie les 10 dernières par rareté.
   - Les anciens fichiers restent lisibles : la rareté y est simplement inconnue.

## Hors champ

- Pas de nouvelle page de stats par rareté : ça viendra avec les stats côté serveur.

## Livraison

Même branche que le pool (`claude/pool-partage`), version 1.20.0 non publiée, dans un commit à part.
