# Fiche par carte — conception

Script 1.29.0. Script seul, le serveur ne change pas. Ce chantier vient après la réception de tout le pool (1.28.0, conception à part) : c'est elle qui met sous la main l'historique d'une carte du marché qu'on n'a pas.

## Pourquoi

Jules veut savoir **si une carte vaut le coup d'être vendue maintenant, ou achetée maintenant**.

Aujourd'hui, le script donne une valeur par carte : la médiane des 7 derniers jours quand il y a au moins 3 ventes, sinon celle de toutes les ventes connues. Il en tire trois choses :
- l'enchère max conseillée, égale à la valeur ;
- les bonnes affaires, des annonces à 30 % ou plus sous la valeur ;
- le prix de vente conseillé, égal à la valeur.

Mais rien ne dit si le prix du moment est haut ou bas par rapport à son habitude, s'il monte ou baisse, ni si la carte se vend facilement.

La « tendance » actuelle (`trendOf`) compare la moitié récente des ventes gardées à la moitié ancienne. Depuis la 1.27, ça peut couvrir des mois, sans dire sur quelle durée.

## Décisions de Jules

- **La fiche donne des repères, sans verdict.** Elle montre une courbe et quelques signaux écrits en clair. Jules décide. Aucun seuil ne tranche à sa place par un « vends » ou un « achète ».
- **La fiche est une vue du panneau Stats**, pas une fenêtre à part.

## Objectifs

- Une fiche par carte et par rareté, qui répond à « maintenant » :
  - le prix du moment face à son habitude ;
  - son sens ;
  - la facilité à vendre ;
  - la concurrence ;
  - pour une carte à toi, ce que la vente te rapporterait ;
  - devant une annonce, ce qu'elle vaut.
- L'ouvrir depuis le panneau (Collection, À vendre, Souhaits) et depuis une pastille sur le site.
- Reprendre les deux repères principaux en une ligne dans la bulle des pastilles.

## Hors sujet

- Un avis « vendre » ou « acheter » : pas dans cette version. Il pourra venir par-dessus les repères, si ceux-ci s'avèrent fiables.
- Des alertes ou des notifications.
- Toute requête au site sans clic de Jules.
- Changer la valeur, la fiabilité, les bonnes affaires ou l'enchère max ailleurs dans le script.

## À éviter absolument

- **Une fiche qui contredit le reste du script.** Les ventes de la fiche sont celles qui font la valeur affichée partout : même source, même rareté (voir plus bas).
- **Un signal affirmé sur trop peu de ventes.** Sous les minimums, la fiche dit « pas assez de ventes » au lieu d'un chiffre.
- **Ralentir le site.** Les calculs ne se font qu'à l'ouverture de la fiche. La ligne de la bulle se calcule avec la bulle, et elle est gardée en cache comme `priceOf`.

## Approches envisagées

1. **Une vue dans le panneau Stats (retenue par Jules).** La fiche prend la place de l'onglet en cours, avec un bouton « ← Retour ». Elle a la place pour une courbe et la liste des ventes, et elle garde le même style que le reste. Sur la page Marché, elle cache l'annonce : on ferme avec Échap pour enchérir.
2. **Une fenêtre flottante à part**, d'environ 400 px, qui laisse l'annonce visible. Elle demande un deuxième style de fenêtre, et elle est trop étroite pour une courbe lisible sur des semaines. Écartée.
3. **Agrandir la bulle.** Elle disparaît dès que la souris s'en va. Écartée.

## Conception

### Les ventes de la fiche

- **Source :** celle que `priceOf` retient pour la carte et la rareté, dans cet ordre : historique Pro, puis tes ventes, puis prix observés. On prend toutes ses ventes, pas seulement la fenêtre qui fait la valeur.
  - Il faut une petite fonction qui rende cette liste complète, en partageant le choix de source avec `priceOf` pour ne pas le dupliquer.
- **Rareté :**
  - ouverte depuis une pastille posée sur une annonce de rareté connue : celle de l'annonce, pour que la fiche montre la même valeur que la pastille *(choix de Claude, au plan : l'ordre initial faisait passer ton exemplaire d'abord, et la fiche aurait alors contredit la pastille)* ;
  - sinon celle de ton exemplaire (ou celle de la ligne du panneau d'où l'on ouvre) ;
  - sinon `rarityOf` ;
  - sinon la première rareté qui a des ventes.

  Des pastilles en haut de la fiche permettent de passer aux autres raretés qui ont des ventes *(choix de Claude)*.
- **Pas de mélange de raretés.** `priceOf` se rabat sur les ventes d'autres raretés quand il n'y en a aucune à la rareté voulue (fiabilité 0). La fiche, elle, ne mélange pas : elle dit « aucune vente connue à cette rareté » et montre les pastilles des raretés qui en ont.
- **Sur la courbe, en plus :** tes propres ventes et tes achats de cette carte (`db.auctions`, sortes `s` et `b`), à la même rareté. Ils ont leur propre marque. Ils ne comptent dans les repères que s'ils font partie de la source retenue.

### Les repères

Tous les seuils sont des choix de Claude, regroupés en constantes pour pouvoir les ajuster.

1. **Le prix du moment face à son habitude.**
   - On compare la médiane des 7 derniers jours (au moins 3 ventes) à la médiane des 30 jours d'avant, du 8ᵉ au 37ᵉ jour (au moins 5 ventes).
   - Écart de +15 % ou plus : « **plus cher que d'habitude** (+X %) ».
   - Écart de −15 % ou moins : « **moins cher que d'habitude** (−X %) ».
   - Entre les deux : « **dans son habitude** ».
   - Sous les minimums : « pas assez de ventes pour comparer ».
2. **Le sens.**
   - On calcule la pente des prix sur les 30 derniers jours (au moins 6 ventes), exprimée en % par semaine.
   - La pente est robuste aux ventes aberrantes : médiane des pentes entre paires de ventes (Theil-Sen), sur le logarithme du prix. On garde au plus les 300 ventes les plus récentes de la fenêtre.
   - +5 % par semaine ou plus : « **en hausse** (+X % par semaine) ».
   - −5 % ou moins : « **en baisse** ».
   - Entre les deux : « **stable** ».
3. **Le rythme des ventes.**
   - Le nombre de ventes des 30 derniers jours, ramené à la semaine : « se vend **environ N fois par semaine** ».
   - Avec la date de la dernière vente : « dernière vente il y a 2 j ».
   - Moins d'une vente par semaine : « se vend **environ N fois par mois** » *(choix de Claude, au plan : « 0,4 fois par semaine » se lit mal)*.
   - Aucune vente en 30 jours : « **aucune vente en 30 jours** ».
   - Le compte se fait sur la source retenue. Un historique Pro relevé rarement peut donc sous-estimer le rythme : c'est accepté, pour rester cohérent avec la valeur.
4. **La concurrence.**
   - Les annonces en cours à cette rareté, connues du script (`db.market.asks`, comme `askOf`) : « **4 en vente**, la moins chère à 120 ₩ ».
   - Avec l'âge du relevé : « relevé il y a 2 h ». C'est la date de la dernière recherche de la carte (`db.wishSeen[carte]`), sinon celle de l'annonce (`asks[carte].t`).
   - Sinon : « aucune annonce connue (relevé il y a …) », ou « annonces jamais cherchées » quand la carte n'a jamais été cherchée (pas de `db.wishSeen[carte]`).
5. **Pour toi**, si tu as la carte.
   - Ce qu'elle t'a coûté, avec `originOf` et `originText`.
   - Ce que la vendre à sa valeur te rapporterait : « **+Y ₩** », avec `profitTag`.
6. **Face à l'annonce**, si la fiche est ouverte depuis une pastille sur une annonce.
   - Son prix actuel comparé à la valeur de sa rareté : l'écart en %, le repère « bonne affaire » existant et l'enchère max conseillée.

### La fiche

- **En-tête :** le nom de la carte, ses pastilles de rareté, la valeur (comme partout) avec sa fiabilité, et « ← Retour ».
  - Sans vente à cette rareté, la valeur reste celle du reste du script (« ≈ », prix d'autres raretés, douteux), avec cette mention ; le corps de la fiche, lui, ne montre aucune vente d'une autre rareté.
  - Le nom vient de la collection ou des souhaits. Pour une carte du marché, c'est le titre lu sur la carte du site au moment du clic.
- **Les repères** en tête, une ligne chacun, dans l'ordre ci-dessus.
- **La courbe :** un SVG dessiné par le script, comme celle de la bulle (`sparkline`), sans bibliothèque.
  - L'axe des dates est réel : les ventes ne sont pas espacées régulièrement.
  - Les périodes sont 7 j, 30 j, 90 j et tout. Par défaut 30 j, ou tout s'il y a moins de 10 ventes en 30 jours.
  - Deux segments horizontaux montrent le repère 1 : la médiane des 30 jours d'avant, en pointillés, et celle des 7 derniers jours.
  - Une vente Pro ou exacte est un point plein. Un prix provisoire, qui n'est qu'un minimum, est un point creux. Tes ventes et tes achats ont leur propre marque.
  - L'axe des prix est borné aux 2ᵉ et 98ᵉ centiles, pour qu'une vente aberrante n'écrase pas la courbe. Une vente hors bornes est dessinée au bord.
  - Le survol d'un point donne sa date, son prix et sa sorte.
- **La liste des ventes :** un tableau triable, fait avec `sortTable`, des colonnes date, prix, rareté et sorte (Pro, exacte, provisoire, toi).
  - Ce sont les ventes de la source retenue ; « toi » quand cette source est tes ventes et achats. Tes ventes et achats en plus de la source ne sont que sur la courbe *(choix de Claude, au plan : une même vente serait sinon listée deux fois, Pro et toi)*.
  - Les 50 plus récentes sont affichées, avec un bouton « Tout afficher ».
- **Deux actions sur un clic** *(choix de Claude)*, avec les fonctions existantes :
  - « Chercher les annonces de cette carte » (`marketSearch([[carte, nom]], …)`, une requête : la recherche se fait par le nom) ;
  - pour un compte Pro, « Relever l'historique Pro » (`fetchPricesFor([[carte, rareté]], …)`, une requête).

  Leur état s'affiche sur une ligne d'état propre à la fiche. La fiche se redessine à la fin. Les boutons sont grisés pendant qu'un autre traitement tourne (`job.running`). La recherche est grisée aussi quand le nom de la carte est inconnu, puisqu'elle se fait par le nom *(choix de Claude, au plan)*.

### Ouvrir la fiche

- **Dans le panneau :** un petit bouton 📈 à côté du nom de la carte, dans Collection, À vendre et Souhaits. Le nom garde son lien vers le site.
- **Sur le site :** un clic sur une pastille ouvre le panneau sur la fiche de cette carte, avec l'annonce si la pastille en porte une.
  - Le clic ne doit pas suivre le lien de la carte du site : un écouteur en phase de capture appelle `preventDefault` et `stopPropagation`.
  - Le curseur de la pastille passe de `help` à `pointer`.
- **« ← Retour »** ramène à l'onglet d'où l'on vient. Cliquer un onglet de la barre ferme aussi la fiche. Échap ferme le panneau, comme aujourd'hui. La fiche n'est pas un onglet de la barre.
  - Fermer le panneau (Échap, ×, clic à côté) ferme aussi la fiche : le bouton 📊 rouvre l'onglet d'où l'on venait *(choix de Claude, au plan)*.
- **Pour une carte à toi**, le coût vient de l'exemplaire non shiny à la rareté affichée : `originOf(carte, rareté, false, maintenant)`.

### Dans la bulle

- Une ligne de plus, avec les repères 1 et 2 en court : par exemple « Repères : plus cher que d'habitude · en baisse ».
- Elle n'apparaît que si au moins l'un des deux est calculable. Plus une mention « Clic : fiche de la carte ».
- Le cache de cette ligne suit les ventes de la carte (leur nombre et la plus récente) : de nouvelles ventes reçues la changent tout de suite, sans tout recalculer à chaque rafraîchissement *(choix de Claude, au plan)*.

## Laissé au développeur

- Le nom et la forme de la fonction qui calcule les repères. Elle doit être pure, et prendre en entrée les ventes, la date du moment et les annonces, pour se tester avec le harnais.
- La mise en page exacte de la fiche, dans le style du panneau.
- Où ranger l'état de la fiche dans `ui` : carte, rareté, annonce, onglet d'origine, période.

## Tests attendus

- **Repère 1 :** plus cher, moins cher, dans son habitude, et pas assez de ventes (2 ventes sur 7 jours, ou 4 ventes sur les 30 jours d'avant).
- **Repère 2 :** hausse, baisse et stable, avec une vente aberrante qui ne doit pas renverser le sens, et moins de 6 ventes.
- **Repère 3 :** environ N fois par semaine, et aucune vente en 30 jours.
- **Repères 4 à 6 :**
  - la concurrence à la bonne rareté seulement, et l'âge du relevé ;
  - le gain pour une carte achetée ;
  - l'écart face à une annonce.
- **Source :** la fiche prend la même source que `priceOf`, sur une carte avec un historique Pro et des prix observés.
- **Ouverture :** le clic sur une pastille ouvre la fiche sans suivre le lien, et « ← Retour » ramène à l'onglet d'origine.
- **Bulle :** la ligne de repères apparaît, et elle est absente sans ventes suffisantes.
