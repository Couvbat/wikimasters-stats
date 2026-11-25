# WikiMasters – Stats de collection

Un bouton « 📊 Stats » ajouté sur wiki-masters.com : valeur de ta collection, cartes à vendre en priorité, stats de boosters, comparaison entre amis, export CSV.

Le script ne fait que lire. Il n'ouvre pas de paquet, ne met rien aux enchères, n'échange rien et ne défausse rien. Seule exception, à ta demande et après ton clic : l'étiquetage par lots, qui ajoute une de tes étiquettes à des cartes. Les données restent dans ton navigateur.

**Pas développeur ?** Suis le **[guide pas à pas](GUIDE.md)** : du téléchargement à l'utilisation, avec le pool de prix du groupe.

## Installer

Testé avec Tampermonkey sur Chrome et sur Zen.

1. Installe **Tampermonkey** : Chrome Web Store pour Chrome, addons.mozilla.org pour Zen ou Firefox.
2. **Sur Chrome seulement : autorise les scripts utilisateur, sinon rien ne se lance.** Ouvre `chrome://extensions`, clique sur « Détails » de Tampermonkey et active « Autoriser les scripts utilisateur ». Si cette option n'existe pas chez toi, active le « Mode développeur » en haut à droite de la page des extensions. Rien à faire sur Zen ou Firefox.
3. **Ouvre ce lien** : [installer le script](https://raw.githubusercontent.com/Couvbat/wikimasters-stats/main/wikimasters-stats.user.js). Tampermonkey affiche une page d'installation : clique sur « Installer ».
4. Recharge wiki-masters.com (F5). Le bouton « 📊 Stats » apparaît en bas à droite.

### Mises à jour

Installé par ce lien, le script se met à jour tout seul : Tampermonkey vérifie une fois par jour s'il existe une version plus récente. Pour ne pas attendre : onglet **Réglages** du panneau, « Vérifier » puis « Installer la dernière version ». Tampermonkey affiche sa page de mise à jour, clique sur « Mettre à jour » et recharge le site. Quand une nouvelle version est publiée, un lien « Version X disponible » apparaît aussi en haut du panneau.

**Si tu avais installé le script en le collant à la main**, il ne se mettra pas à jour : supprime-le du tableau de bord Tampermonkey, puis réinstalle-le avec le lien ci-dessus. Tes données ne sont pas perdues, elles sont rangées par le site et non par le script.

### Installation manuelle

Si le lien ne fonctionne pas : icône Tampermonkey, « Créer un nouveau script », efface tout, colle le contenu de `wikimasters-stats.user.js`, puis Ctrl+S. Cette méthode ne donne pas de mises à jour automatiques.

Violentmonkey devrait aussi convenir, mais le script n'a pas été testé avec.

### Si le bouton n'apparaît pas

- Sur Chrome, revérifie l'étape 2 : c'est la cause la plus fréquente.
- Dans le tableau de bord de l'extension, « WikiMasters – Stats de collection » doit être dans la liste, avec son interrupteur allumé. S'il n'y est pas, le script n'a pas été enregistré : réinstalle-le avec le lien ci-dessus.
- Sur le site, l'icône de l'extension doit afficher un petit « 1 ». Sinon, recharge la page.

## Utiliser

Le panneau a onze onglets. Dans tous les tableaux, un clic sur un en-tête de colonne trie selon cette colonne, et un second clic inverse le sens.

**Survole un bouton, une case ou un petit « ? »** : une bulle explique ce qu'il fait. Les boutons sont regroupés par rôle, et les options moins utiles sont rangées dans des sections repliables.

### Valeur sur les cartes du site

Sur les pages du site (Collection, Marché, Toutes les cartes, boosters…), chaque carte dont le prix est connu porte une petite pastille en haut à droite : sa valeur médiane. Le contour dit la fiabilité (vert fiable, orange moyen, gris douteux), « ≈ » signale un prix douteux et « ✓ » une carte que tu as déjà. Sur le Marché, la pastille compare aussi avec le prix de l'annonce : verte « −40 % » pour une bonne affaire, rouge « trop cher » quand l'annonce atteint déjà la valeur. Survole la pastille : une bulle donne le nombre de ventes, l'enchère max conseillée, la marge, et une petite courbe des dernières ventes (médiane en pointillés). Elle reprend aussi deux repères en court, par exemple « Repères : plus cher que d'habitude · en baisse ». **Un clic sur la pastille ouvre la fiche de la carte** dans le panneau (voir plus bas), sans suivre le lien du site. Une carte jamais relevée n'a pas de pastille.

Sur l'onglet **Mes enchères** du Marché :

- quand quelqu'un passe devant toi, la pastille devient bleue « ↑ 240 ₩ » si tu peux encore remonter jusqu'à la valeur, ou rouge « laisse filer » si l'enchère la dépasse déjà ;
- le prix des cartes où tu enchéris est relevé tout seul : une carte à la fois, environ une par seconde, seulement si son prix date de plus de 24 h. Si le site freine ou si un autre relevé est en cours, le script s'arrête et reprend à ton prochain passage.

Une carte **shiny** en vente porte « ✦ » au lieu d'une comparaison : l'historique du site ne dit pas quelles ventes étaient shiny, donc la valeur affichée est celle d'une carte normale. Les enchères shiny sont aussi exclues des prix observés et de tes ventes, pour ne pas fausser la valeur des cartes normales.

**Sur la page Échanges du site**, chaque échange affiche sa valeur : ce que tu donnes, ce que tu reçois, l'écart (wikibidous compris). Dans la fenêtre « Échanger avec… », le total se met à jour en haut au fur et à mesure que tu choisis les cartes des deux côtés. Le script n'ajoute qu'une ligne de texte : il ne choisit rien et n'envoie rien.

### Fiche d'une carte

Pour savoir si une carte vaut le coup d'être vendue ou achetée maintenant. On l'ouvre avec le petit bouton 📈 à côté du nom d'une carte (onglets Collection, À vendre et Souhaits), ou d'un clic sur une pastille du site ; « ← Retour » ou un onglet la referment. Elle donne **des repères, pas des conseils** : à toi de décider.

La fiche porte sur une carte et une rareté (des pastilles en haut passent aux autres raretés qui ont des ventes). Ses ventes sont celles qui font la valeur affichée partout : l'historique Pro, sinon tes ventes et achats, sinon les prix observés, sans jamais mélanger les raretés. Sous les minimums, elle dit « pas assez de ventes » plutôt qu'un chiffre.

- **Prix du moment** : la médiane des 7 derniers jours (3 ventes au moins) face à celle des 30 jours d'avant (5 au moins). « Plus cher que d'habitude » à +15 % et au-delà, « moins cher » à −15 %, sinon « dans son habitude ».
- **Sens** : la pente des prix sur 30 jours (6 ventes au moins, étalées sur une semaine au moins), en % par semaine, peu sensible à une vente aberrante ; des ventes groupées sur un même jour ne se comparent pas entre elles. « En hausse » à +5 % par semaine, « en baisse » à −5 %, sinon « stable ».
- **Rythme** : combien de fois la carte se vend par semaine (ou par mois), et sa dernière vente. Avec l'historique du site (voir plus bas), c'est le rythme de tout le marché, sur les 4 dernières semaines.
- **Concurrence** : les annonces en cours connues à cette rareté, la moins chère, et l'âge du relevé.
- **Pour toi**, si tu as la carte : ce qu'elle t'a coûté, et ce que la vendre à sa valeur te rapporterait.
- **Face à l'annonce**, si tu viens d'une pastille du Marché : l'écart avec la valeur, la bonne affaire éventuelle, l'enchère max conseillée.

Dessous, une **courbe** des ventes sur 7 jours, 30 jours, 90 jours ou tout, avec des prix ronds et des dates sur les axes. Chaque vente est un point (creux : prix provisoire, un minimum). Un trait clair suit le prix médian sur 3 jours glissants (plus long quand les ventes sont rares), dans une bande verte qui contient la moitié des ventes ; il s'interrompt quand des jours de suite n'ont aucune vente. Une vente trop loin des autres est un petit triangle rouge au bord, son prix au survol. Losanges : tes ventes et tes achats. L'axe des dates commence à la première vente connue de la période, et la courbe prend toute la largeur de la fiche. Une légende, en haut, ne montre que les symboles dessinés. **Passe la souris sur la courbe** : une bulle donne la vente la plus proche (date, heure, prix) et le détail du jour sous la souris (ses ventes, le prix médian, la moitié des ventes, la moyenne du site de la semaine). Puis la **liste des ventes**, triable. Deux boutons, sur ton clic : « Chercher les annonces de cette carte » (une requête) et « Relever les ventes » (les 5 dernières ventes, puis l'historique des prix par semaine : deux requêtes). Un prix encore à jour n'est pas relevé de nouveau : la fiche dit quand il l'a été (et par qui, s'il vient du pool). Pendant la pause que le site impose aux relevés automatiques, l'historique attend, et la fiche dit jusqu'à quand.

**Historique des prix par semaine.** Le site calcule, pour chaque carte et chaque rareté, la moyenne de ses ventes semaine par semaine sur environ 3 mois, avec le minimum, le maximum et le nombre de ventes. Le script le garde quand le site le charge (sa « Vue du marché », sur la page d'une annonce) ou quand tu cliques « Relever les ventes » : jamais de requête en plus sinon. Il sert à la fiche : le rythme du marché ; le prix du moment et le sens quand les ventes connues ne suffisent pas, marqués « moyennes du site » (cette semaine face aux 4 semaines d'avant, tendance des 8 dernières semaines, mêmes seuils) ; et, sur la courbe, une ligne grise des moyennes par semaine, un carré par semaine (minimum, maximum et nombre de ventes au survol). L'axe des prix contient toujours ces moyennes. Ce sont des moyennes : la valeur, elle, reste la médiane des ventes.

### Réglages

Tout ce que le script ajoute aux pages du site se règle dans l'onglet Réglages : afficher la valeur, comparer au prix de l'annonce, conseil quand tu es surenchéri, ✓ sur les cartes que tu as, bulle détaillée (ou la bulle simple du navigateur), contour vert des bonnes affaires, cartes trop chères grisées (désactivé par défaut ; elles redeviennent normales au survol, et tes propres enchères ne sont jamais grisées), valeur des échanges, les relevés automatiques (cartes tirées d'un booster, cartes de Mes enchères), et la mise à jour automatique (tous comptes, désactivée par défaut ; voir « Prix observés »), avec le bouton « Tout mettre à jour maintenant ». On y trouve aussi la version installée et le bouton de mise à jour.

### Accueil

L'essentiel en une page, à l'ouverture du panneau : une rangée de chiffres clés (valeur et variation, cartes, places de vente libres, revenus de la semaine, bonnes affaires), puis des blocs. Un bloc « À vérifier » apparaît en tête quand les chiffres risquent d'être faux : collection pas rechargée depuis plus d'un jour, ou cartes L, UR, SR sans prix relevé. Ensuite : valeur de la collection et variation depuis le dernier relevé, les cartes à vendre en premier avec tes places libres, tes souhaits en vente (bonnes affaires d'abord, puis ceux qui finissent bientôt), tes enchères en cours (qui mène, combien tu as engagé pour quelle valeur), ton dernier booster et tes dernières enchères. Chaque bloc a un lien « voir → » vers son onglet.

### Collection

- **Recharger ma collection** : lit toute ta collection (une dizaine de requêtes, comme quand tu feuillettes les pages).
- **Relever les prix** : va chercher les dernières ventes des cartes des raretés cochées, à la rareté de chaque carte. Depuis sa mise à jour de novembre 2026, le site n'en donne plus que 5 par carte (avant : jusqu'à 200). Les relevés s'additionnent : chaque relevé ajoute ses ventes à celles déjà connues de la carte, sans doublon, une carte par seconde, avec un bouton Stop. Un prix relevé est gardé 24 h. Il arrive que le site réponde « aucune vente » pour une carte qui en a : pour les raretés L, UR, SR et R, une réponse vide est donc redemandée une fois, et n'est gardée qu'une heure.
- **Relever les fins d'enchères** : lit les 500 enchères sur le point de se terminer, plus 150 de chaque rareté L, UR et SR (qui sinon se perdent parmi les centaines d'enchères qui finissent chaque minute), pour enregistrer leur prix (voir « Prix observés » plus bas). Le script enregistre aussi tout seul ce que tu vois en parcourant la page Marché du site.
- **Relever les prix finaux** : quelques minutes plus tard, lit le prix final exact de ces enchères. Pour tous les comptes, Pro ou non. Comme il n'en lit qu'une par seconde, il commence par tes cartes et tes souhaits, puis les raretés qui valent le plus (L, UR, SR…), puis les enchères qui avaient reçu une offre. Une carte qui a déjà dix prix exacts plus récents n'est pas relue.
- **Chercher mes cartes sur le marché** : cherche les cartes des raretés cochées pour voir qui les vend en ce moment et à quel prix, dans la colonne « En vente à ». Elle traite toutes les cartes d'un coup, une par seconde, et saute celles cherchées depuis moins d'une heure.
- **Rafraîchir les annonces** : relit le prix et la fin des annonces déjà affichées dans cette colonne, sans attendre.
- **Étiquetage par lots** : ajoute une de tes étiquettes à un lot de cartes, choisi par une règle.
  - Les règles : cartes de la liste À vendre, cartes qui valent 1 ₩, doublons, une rareté, valeur au moins N ₩.
  - Le groupe annonce le lot (« 12 cartes → À vendre », survole pour voir lesquelles). Le premier clic sur « Appliquer ce lot » demande confirmation, le second l'applique.
  - Le lot part en une seule requête, comme quand tu étiquettes plusieurs cartes en mode « Sélectionner » sur le site. 200 cartes au plus par lot.
  - **C'est la seule fonction du script qui modifie ton compte**, et seulement après ton clic. Elle ne fait qu'ajouter une étiquette qui existe déjà : elle n'en crée, n'en retire et n'en supprime aucune.
  - Le script lit tes étiquettes et la session du site quand le site les charge sur la page Collection. Il garde la session en mémoire seulement : jamais enregistrée, jamais exportée.
- **Exporter en CSV** : le tableau tel qu'il est filtré et trié, à ouvrir dans Excel ou LibreOffice.
- Clique sur un en-tête de colonne pour trier.

### À vendre

La liste des cartes qui méritent une place aux enchères, les plus chères d'abord. Tu règles la valeur minimale, et tu choisis d'inclure ou non tes favoris et les prix douteux (inclus par défaut : décoche la case pour ne garder que les prix fiables ou moyens). La case « Doublons d'abord » fait passer devant les cartes que tu as en plusieurs exemplaires. Les cartes déjà en vente sont retirées, et les lignes surlignées tiennent dans tes places de vente libres.

La colonne « Concurrence » montre l'annonce la moins chère d'un autre joueur sur la même carte (bouton « Chercher la concurrence »). Le prix conseillé reste la médiane des ventes : une mise de départ ou une offre en cours n'est pas un prix final, donc le script ne s'aligne jamais dessus. Une étiquette « concurrent à X ₩ » signale seulement un concurrent qui a déjà reçu une offre sous la médiane. Tes propres annonces ne comptent pas comme concurrence.

Un clic sur le nom d'une carte ouvre, dans un nouvel onglet, la page Collection du site avec le formulaire « Mettre aux enchères » de cette carte déjà ouvert. Le script s'arrête là : la mise de départ, la durée et le bouton « Lancer l'enchère » restent à toi.

### Mes ventes

**Tes ventes en cours**, en haut de l'onglet : le bilan de tes annonces en cours, lu à chaque passage sur la page Marché.
- Des tuiles :
  - combien sont en vente, sur tes places de vente ;
  - combien ont reçu une offre ;
  - ce que tu toucherais si tout partait maintenant ;
  - la valeur de ces cartes ;
  - combien sont encore sous leur valeur.
- Un tableau, une ligne par annonce : mise de départ, offre actuelle (un lien vers l'annonce), valeur à la rareté de l'exemplaire, écart en vert ou en rouge, et temps restant.
- L'étiquette « mise > valeur » signale une annonce sans offre dont la mise de départ dépasse la valeur : elle risque de rester invendue.
- Une shiny porte ✦ sans comparaison, comme ailleurs.
- **Origine et profit** : pour chaque annonce, d'où vient la carte et ce qu'elle te rapporterait au prix actuel.
  - Achetée aux enchères : le prix que tu as payé.
  - Tirée d'un booster : 0 ₩.
  - Reçue par échange : « ≈ » ce que tu as donné, réparti entre les cartes reçues.
  - Ni achat ni échange connu : « booster probable », comptée à 0 ₩. Les achats et les échanges viennent d'historiques que le site renvoie, mais un booster n'est vu qu'au moment où tu ouvres le paquet avec le script actif sur la page (bouton 📊 présent). Si le bouton manque parfois sur la page Paquets, voir « Si le bouton n'apparaît pas ».
  - Le script retient la dernière acquisition de cette carte, à la même rareté, avant la mise en vente.
  - La tuile « Profit si tout part maintenant » fait le total, et dit combien d'origines sont devinées.
  - Aucune commission du Marché n'est connue, donc le profit est calculé sans commission.

Le bilan de tes enchères terminées : ventes réussies et invendus, revenus, achats, solde, détail par rareté, comparaison entre mise de départ et prix obtenu, et profit de chaque vente réussie quand l'origine de la carte est connue. Le site ne donne que tes enchères les plus récentes ; le script les garde en mémoire à chaque passage sur la page Marché, donc le bilan s'allonge avec le temps.

### Échanges

Le bilan de tes échanges avec d'autres joueurs : échanges conclus, refusés et contre-proposés, cartes données et reçues, et bilan en valeur. Deux tableaux détaillent avec qui tu échanges et ce que tu donnes et reçois par rareté. Dans la liste, un clic sur un échange le déplie pour montrer les cartes de chaque côté.

Les échanges sont lus sur la page Échanges du site, à chaque visite ou avec le bouton « Actualiser mes échanges », et gardés en mémoire. Les valeurs sont celles d'aujourd'hui, pas celles du jour de l'échange.

Une carte que tu as donnée n'est plus dans ta collection, donc l'onglet Collection ne relève jamais son prix. Le bouton « Relever les prix des cartes échangées » le fait pour toutes les cartes passées dans tes échanges. Tant qu'une carte n'a pas de prix connu, elle n'est pas comptée : elle apparaît comme « + 1 ? » et le bilan est marqué incomplet, plutôt que d'afficher une valeur inventée.

### Souhaits

Ta liste de souhaits est celle du site : les cartes pour lesquelles tu as demandé une alerte dans « Toutes les cartes ». Clique sur « Charger ma liste de souhaits » pour la lire.

Le marché compte des milliers d'enchères, donc le script ne le parcourt pas en entier. Il retient à la place les alertes de mise en vente que le site t'envoie pour ces cartes. « Vérifier les annonces signalées » cherche chacune d'elles sur le marché par son titre, et affiche le prix le plus bas, la fin de l'enchère et si une offre a déjà été faite. C'est une recherche par seconde, avec un bouton Stop. Les enchères terminées sont retirées.

« Rafraîchir les annonces » relit le prix et la fin des annonces déjà listées, sans attendre : utile avant d'enchérir, puisque les offres montent.

**Bonnes affaires** : une annonce au moins 30 % sous la valeur médiane de la carte (sur 3 ventes ou plus) porte une étiquette verte « bonne affaire −40 % » et remonte en tête. Une case filtre sur elles seules. Pour qu'elles soient repérées, il faut la valeur médiane : « Relever les prix des souhaits en vente » la relève pour les seuls souhaits actuellement en vente.

**Annonces de plusieurs raretés** : chaque annonce porte la rareté de son exemplaire. La ligne d'une carte présente d'abord les annonces à la rareté de ta liste, et une annonce d'une autre rareté porte son étiquette, sur la ligne comme une fois dépliée. Bonne affaire, enchère max et marge comparent chaque annonce à la valeur de sa propre rareté.

**Enchère max** : la valeur médiane de la carte. Jusqu'à ce montant, tu ne paies pas la carte plus cher qu'elle ne se vend d'habitude. L'étiquette verte « +75 ₩ » donne la marge qu'il te reste sur l'annonce de la ligne, la rouge « trop cher » dit qu'elle a déjà dépassé. En dépliant une carte, chaque annonce a sa propre marge.

**Mes enchères** : en haut de l'onglet, le bilan des enchères où tu as fait une offre, lu sur l'onglet Mes enchères du Marché : combien tu en mènes, les wikibidous engagés, la valeur des cartes, ce que tu gagnes ou perds si tu remportes tout, et les enchères où ton offre dépasse déjà la valeur. Le tableau donne pour chacune le statut, ton offre, la valeur, l'enchère max avec sa marge, et le temps restant.

Les alertes de plus de 12 h sont ignorées : une enchère dure 12 h au plus, elles concernent donc forcément une vente terminée.

« Chercher mes souhaits sur le marché » fait la même recherche pour toutes les cartes de ta liste, qu'il y ait eu une alerte ou non. Elle traite toute la liste d'un coup, en commençant par celles jamais cherchées. Choisis une rareté pour cibler. Une carte cherchée depuis moins d'une heure est sautée.

Chaque carte a une ligne. Quand elle est mise en vente plusieurs fois, la ligne porte une étiquette « 3 annonces » et décrit une seule de ces annonces, prix et fin d'enchère ensemble. Laquelle dépend du tri : la moins chère par défaut (« dès 30 ₩ »), la plus chère si tu tries par prix décroissant (« jusqu'à 120 ₩ »), celle qui finit le plus tôt ou le plus tard si tu tries par fin d'enchère. Le lien du prix mène à cette annonce-là. Un clic sur la ligne la déplie pour montrer chaque annonce avec son prix, sa fin et son lien ; un second clic la replie. Le bouton « Tout déplier » ouvre toutes les cartes d'un coup. Dans l'onglet Collection, la colonne « En vente à » affiche la moins chère suivie du nombre d'annonces entre parenthèses.

La case « Cacher les cartes que je possède déjà » retire de la liste les souhaits déjà présents dans ta collection, et les exclut aussi de la recherche sur le marché. Elle s'appuie sur la collection chargée dans l'onglet Collection, et reste cochée d'une visite à l'autre. Sans elle, ces cartes portent une étiquette « possédée ».

Le prix d'une annonce est un lien : un clic ouvre cette enchère sur le site, dans un nouvel onglet. Une alerte pas encore vérifiée a aussi son lien.

L'onglet indique aussi si un ami possède la carte, d'après les fichiers importés dans l'onglet Amis.

### Boosters

Chaque paquet que tu ouvres toi-même est mémorisé : nombre de boosters, part de chaque rareté, valeur moyenne par booster, meilleurs tirages. Seuls les boosters ouverts depuis l'installation de la version 1.3 sont comptés.

Un petit panneau affiche aussi, juste après l'ouverture, le prix de chaque carte tirée et un conseil. Une case dans l'onglet Réglages permet de le désactiver.

### Évolution

Une courbe de la valeur totale, du nombre de cartes ou du nombre de cartes déjà vendues, avec un point par jour où ta collection a été chargée ou consultée. Elle apparaît à partir du deuxième jour.

### Amis

**Avec le pool du groupe, c'est automatique.** Dans Réglages, groupe « Pool partagé du groupe », coche « Partager ma collection et mes souhaits avec le groupe » (il faut un pseudo, à écrire dans l'onglet Amis). Ta collection et ta liste de souhaits partent au pool après chaque relecture, et tu retrouves dans l'onglet Amis, marqués « via le pool », tous les membres qui ont coché la case. Seules ta collection et ta liste de souhaits partent, pas tes prix (ils passent déjà par le pool) ni rien d'autre de ton compte. Tous les membres qui ont la clé les voient. Décocher la case retire ton profil du pool. Un ami du pool ne compte pas dans la limite de 10, et un membre qui ne partage plus disparaît de la liste.

**Sans le pool, par fichier :**

1. Écris ton pseudo et clique sur « Exporter ma collection pour mes amis ».
2. Envoie le fichier à un ami, et demande-lui le sien.
3. Importe son fichier : tu vois ce qu'il a et que tu n'as pas, ce que tu as et qu'il n'a pas, avec les doublons en tête.

Si vos listes de souhaits sont chargées, l'onglet montre aussi les cartes que tu cherches et qu'il possède, et celles qu'il cherche et que tu possèdes.

**Échange proposé** : le script prépare un échange tout fait. D'un côté, les cartes de sa liste de souhaits que tu as en double ; de l'autre, les cartes de ta liste qu'il a en double. Il garde le plus de cartes possible tout en équilibrant la valeur, puis dit combien de wikibidous ajouter d'un côté ou de l'autre. Par défaut, seulement des doublons (personne ne perd une carte) et jamais tes favoris ★ ; la case « Cartes en un seul exemplaire » élargit aux autres. Rien n'est envoyé : c'est toi qui proposes l'échange sur le site.

Avec plusieurs amis, un tableau « Tous mes amis » résume pour chacun ce que tu peux lui donner, ce qu'il peut te donner et la valeur de l'échange équilibré. Un clic sur une ligne ouvre cet ami.

Le fichier contient la liste des cartes, leur nombre d'exemplaires, la liste de souhaits et tous les prix que tu as accumulés : ton historique Pro, les prix observés, et tes propres ventes et achats. Il fonctionne avec ou sans compte Pro.

**Les prix de ton ami remplissent tes tableaux.** À l'import, ses prix s'ajoutent aux tiens : la valeur de tes cartes dans Collection, À vendre, Souhaits et les pastilles du site en profite tout de suite, même sans compte Pro. Pour chaque carte, le relevé le plus récent est gardé, le tien ou le sien. Au survol de la fiabilité ou d'une pastille, « relevé partagé par … » dit d'où vient le prix. Les relevés Pro que tu as reçus d'un ami repartent dans ton propre fichier avec son nom, donc les prix circulent dans tout le groupe. Retirer un ami ne retire pas les prix qu'il a apportés. Les relevés « aucune vente » ne sont pas partagés, car le site en renvoie parfois à tort.

Si le navigateur n'a plus assez de place pour les relevés Pro de ton ami, ils ne sont pas gardés, mais sa collection et ses prix observés le sont : un message le dit.

### Pool partagé du groupe

Le partage par fichier est manuel. Le pool fait la même chose tout seul, pour tout un groupe : une base commune, hébergée par l'un des membres, où chaque prix relevé par quelqu'un sert à tout le monde, Pro et non-Pro mélangés.

- **Ce qui part** :
  - les prix que tu relèves : historique Pro, prix finaux, dernières offres vues, tes ventes et achats ;
  - à l'activation, tes relevés déjà accumulés.
- **Ce qui ne part jamais** : ta collection, tes souhaits, la clé du groupe. Les prix reçus d'un ami ou du pool ne sont pas renvoyés non plus.
- **Ce que tu reçois** : les prix du groupe pour ta collection, tes souhaits et les cartes affichées sur le site, avec « relevé partagé par … » au survol.
- **Moins de requêtes au site** :
  - un prix final déjà relu par un membre n'est plus relu par les autres ;
  - un historique Pro relevé par un membre il y a moins de 24 h n'est pas redemandé.

Pour t'y joindre, dans Réglages, groupe « Pool partagé du groupe » :
1. colle l'adresse et la clé que t'a données la personne qui l'héberge ;
2. clique « Tester » ;
3. coche « Partager et recevoir les prix ».

Le partage est désactivé par défaut. La ligne d'état indique ce qui a été envoyé et reçu, et la dernière erreur s'il y en a.

Si le pool est injoignable (serveur éteint, connexion coupée), le script continue normalement avec tes propres données. Les envois attendent et repartent tout seuls au retour du pool.

Pour héberger un pool : voir [server/README.md](server/README.md). C'est un petit serveur Node, sans dépendance, prévu pour un NAS TrueNAS et un tunnel Cloudflare. En attendant le NAS, il peut tourner sur ton PC (`server/start-local.cmd`, adresse `http://127.0.0.1:8787`), puis tout envoyer au NAS le jour où il est en ligne.

### Sauvegarde

Depuis la 1.24, elles sont rangées dans la base IndexedDB du navigateur, sans la limite d'environ 5 Mo de l'ancien stockage du site. Le passage se fait tout seul au premier chargement : la copie est relue et comparée avant que l'ancien stockage soit effacé. La ligne « Rangées dans IndexedDB : … Mo » de l'onglet Sauvegarde le confirme. Après la mise à jour, recharge tous les onglets du site ouverts. Si le navigateur bloque IndexedDB, le script reste sur l'ancien stockage, et la même ligne le dit.

Depuis la 1.32, les ventes de chaque carte sont rangées à part dans cette base : un enregistrement n'écrit que les cartes qui ont changé (quelques Ko), au lieu de toutes les données (plus de 10 Mo quand le pool du groupe est reçu). Les données sont donc de nouveau écrites tout de suite, sans l'attente de 5 secondes des 1.31. Le passage au nouveau rangement se fait tout seul au premier chargement (moins d'une seconde) ; recharge ensuite les onglets du site ouverts. Une écriture commencée au moment précis où tu recharges ou fermes la page peut encore se perdre : le navigateur ne la finit pas.

Ne reviens pas à une version d'avant la 1.32 : elle n'afficherait plus les ventes (elles restent rangées, et reviennent avec la 1.32). Si un onglet resté sur une ancienne version enregistre entre-temps, la 1.32 fusionne ce qu'il a écrit, sans rien perdre.

Tes données sont rangées dans le navigateur, donc Chrome et Zen ont chacun les leurs. « Exporter toutes mes données » crée un fichier à importer dans l'autre navigateur. L'import fusionne : il ajoute ce qui manque et ne remplace un prix ou une collection que par plus récent. Garde ce fichier pour toi, il contient des prix issus de ton compte.

### Plusieurs comptes

Si tu utilises plusieurs comptes WikiMasters dans le même navigateur, chacun a ses propres données :
- collection ;
- ventes et achats ;
- échanges, boosters, évolution ;
- liste de souhaits, amis, pseudo.

Le script reconnaît tout seul le compte connecté, dès le chargement de la page, et affiche les bonnes données. Les prix du marché, eux, sont communs à tous les comptes du navigateur : ce que l'un relève profite aux autres.

Dans Réglages, le groupe « Compte » indique le compte connecté. Le bouton « Effacer les données de ce compte » (à confirmer par un second clic) vide sa collection, ses ventes, ses échanges, ses boosters, son évolution, ses souhaits et ses amis, sans toucher aux prix.

Les données rangées avant la version 1.20 sont attribuées au premier compte reconnu. Si deux comptes ont déjà été mélangés, recharge la collection de chacun, ou efface les données de l'un pour repartir de zéro.

## Comment lire les chiffres

- **Valeur** : médiane des ventes de la carte **à sa rareté**. Deux valeurs sont calculées :
  - **7 jours** : la médiane des ventes des 7 derniers jours ;
  - **Depuis toujours** : la médiane de toutes les ventes connues.

  La valeur qui compte (totaux, bonnes affaires, enchère max) est celle des 7 derniers jours quand la carte s'y est vendue **au moins 3 fois** à cette rareté, sinon celle depuis toujours. Dans la colonne « Valeur », une petite marque « 7 j » dit que c'est la récente. Les colonnes « 7 jours » et « Depuis toujours » donnent les deux médianes et leur nombre de ventes, et la bulle des pastilles donne les deux. Le script garde toutes les ventes connues de chaque carte, avec un garde-fou de 2 000 ventes par carte (les plus récentes). Une même carte se vend à plusieurs raretés, car des exemplaires de raretés différentes circulent : une L ne se compare qu'aux ventes en L. Sans vente connue à cette rareté, le script prend les ventes plus anciennes dont la rareté n'est pas connue, sinon celles d'autres raretés. Dans ce dernier cas, la valeur est notée « Douteux » et la bulle le dit.
- **En italique** : carte sans vente connue, comptée à 1 wikibidou. C'est ce que rapporte la défausse, donc le minimum qu'une carte puisse valoir.
- **Cartes déjà vendues aux enchères** : le nombre de tes cartes pour lesquelles au moins une vente est connue.
- **Sans vente connue, comptées à 1** : les autres, et la part de la valeur totale qu'elles représentent. Beaucoup de cartes peuvent être dans ce cas tout en pesant très peu dans le total.
- **Fiabilité** : « Fiable » à partir de 5 ventes dont la dernière a moins de 30 jours, « Moyen » à partir de 2 ventes dont la dernière a moins de 90 jours, « Douteux » sinon. Un écart de plus de 5 entre la vente la plus basse et la plus haute fait descendre d'un cran. La flèche indique si les ventes récentes sont plus hautes ou plus basses que les anciennes. Survole le mot pour le détail.
- **Conseil** : « Vendre » si la valeur dépasse 1 wikibidou (ce que rapporte la défausse), sinon « Défausser ». Un clic sur « Vendre ~… » ouvre le formulaire de mise en vente sur le site, comme le nom de la carte dans l'onglet À vendre.
- **En vente à** : le prix d'une enchère en cours sur la même carte. Un point signale qu'elle a déjà reçu une offre. Ce prix est indicatif et n'entre pas dans la valeur.
- **Enchères avec offre en ce moment** : le prix médian, par rareté, des enchères en cours qui ont reçu au moins une offre.

## Prix observés

Le site ne donne que les 5 dernières ventes d'une carte. Pour avoir davantage de prix, le script construit son propre historique à partir de ce que n'importe quel compte peut voir : les enchères en cours.

- Chaque enchère vue (en parcourant le marché, avec « Relever les fins d'enchères », ou pendant une recherche) est suivie jusqu'à sa fin.
- Quand elle se termine, la dernière offre vue devient un prix **provisoire** pour cette carte. C'est un minimum : l'offre a pu monter ensuite.
- **« Relever les prix finaux »** (onglet Collection) relit ensuite la page de chaque enchère suivie : la page qu'on ouvre en cliquant sur une annonce, que tout compte peut voir. Elle donne le prix final exact, qui remplace le prix provisoire. Une enchère finie sans vente retire son prix provisoire, et une enchère vue sans offre peu avant sa fin peut quand même apporter un prix si quelqu'un a enchéri au dernier moment. Une enchère par seconde, avec un bouton Stop.
- Le prix final est aussi enregistré tout seul quand tu ouvres toi-même la page d'une enchère terminée.
- Tant qu'une carte a un prix provisoire, elle n'est jamais notée « Fiable ». Avec uniquement des prix finaux exacts, elle peut l'être, comme avec l'historique Pro. L'origine du prix est indiquée au survol.

**La marche à suivre** : « Relever les fins d'enchères », attendre quelques minutes que ces enchères se terminent, puis « Relever les prix finaux ». À refaire de temps en temps : les prix s'accumulent.

**Mise à jour automatique (option, désactivée par défaut).** Dans l'onglet Réglages, la case « Mise à jour automatique » garde à jour la valeur de ta collection et les prix de tes souhaits, sans cliquer bouton après bouton. Toutes les 30 minutes, tant qu'un onglet du site est ouvert (même en arrière-plan), un passage fait, dans l'ordre :

1. ta collection et ta liste de souhaits, relues en entier une fois par jour ;
2. les souhaits que le site t'a signalés en vente ;
3. les prix à relire, en commençant par les cartes qui pèsent le plus dans ta valeur (valeur × nombre d'exemplaires) : le pool du groupe d'abord, puis l'historique du site ;
4. les prix finaux des enchères suivies, puis les fins d'enchères.

Un prix est à relire **chaque jour** pour une carte qui vaut plus de 50 ₩, une L, une UR ou une carte que tu as mise en vente ; tous les 2 jours pour une SR, 4 jours pour une R, 7 jours pour une C ou une PC. « Relever les prix » et « Relever les valeurs » suivent la même règle. Chaque passage fait 60 requêtes au plus, un seul onglet à la fois. Il s'arrête dès que tu lances un relevé toi-même, et la routine se met en pause 24 h si le site signale trop d'automatisation.

**« Tout mettre à jour maintenant »** (Accueil et Réglages) lance la même chose tout de suite, sans limite, à une requête par seconde ; Stop l'arrête. La ligne en dessous dit ce qu'a fait le dernier passage, et combien de cartes restent à relire.

Ces prix servent de valeur pour une carte quand il n'y a ni historique Pro ni vente personnelle. Comme les autres, ils s'accumulent sans plafond par rareté (2 000 ventes par carte au plus), et la valeur suit la même règle : les 7 derniers jours quand il y a au moins 3 ventes, sinon toutes les ventes. Ils donnent aussi un niveau de prix par rareté, affiché en haut de l'onglet Collection.

Les prix observés partent dans le fichier que tu exportes pour tes amis, avec ton historique Pro et tes ventes et achats, et ceux de tes amis s'ajoutent aux tiens à l'import : à plusieurs, l'historique se remplit plus vite (voir « Amis »).

La couverture reste partielle. Il existe près de trois millions de cartes, et le script ne connaît que les enchères qu'il a vues passer : ne compte pas dessus pour avoir le prix de chaque carte.

## Compte non Pro

Depuis la mise à jour du site de novembre 2026, l'historique des ventes d'une carte est ouvert à tous les comptes : un compte non Pro relève les prix exactement comme un compte Pro (« Relever les prix », mise à jour automatique, boosters, enchères, échanges, souhaits). Le site ne donne plus que les 5 dernières ventes de chaque carte, à sa rareté. S'y ajoutent :

- les prix observés décrits ci-dessus, précisés par leur prix final exact avec « Relever les prix finaux » ;
- les prix partagés par tes amis, par le pool du groupe ou par leur fichier ;
- une valeur pour les cartes que tu as toi-même vendues ou achetées, lue dans ton historique sur la page Marché.

Une carte sans aucune vente connue compte pour 1 ₩, ce que rapporte la défausse.

## À savoir

Les règles de WikiMasters interdisent les scripts qui jouent ou interagissent à ta place. Celui-ci se limite à lire des données que le site t'affiche déjà, mais c'est toi qui choisis de l'utiliser sur ton compte.

## Rythme des requêtes

Les traitements longs (prix, recherches sur le marché, annonces) n'ont plus de plafond : un clic traite toute la liste, à raison d'une requête par seconde, avec le temps restant estimé et un bouton Stop.

Si le site demande de ralentir, le script fait une pause (le délai indiqué par le site, sinon 15 s, puis de plus en plus long), ralentit la suite, et reprend tout seul au même endroit. Il n'essaie pas de contourner cette limite : c'est la protection du site, et ses règles interdisent les outils qui jouent à ta place.

Compte une quinzaine de minutes pour chercher toute une collection de 800 cartes.
