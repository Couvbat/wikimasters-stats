# WikiMasters – Stats de collection

Un bouton « 📊 Stats » ajouté sur wiki-masters.com : valeur de ta collection, cartes à vendre en priorité, stats de boosters, comparaison entre amis, export CSV.

Le script ne fait que lire. Il n'ouvre pas de paquet, ne met rien aux enchères, n'échange rien et ne défausse rien. Les données restent dans ton navigateur.

## Installer

Testé avec Tampermonkey sur Chrome et sur Zen.

1. Installe **Tampermonkey** : Chrome Web Store pour Chrome, addons.mozilla.org pour Zen ou Firefox.
2. **Sur Chrome seulement : autorise les scripts utilisateur, sinon rien ne se lance.** Ouvre `chrome://extensions`, clique sur « Détails » de Tampermonkey et active « Autoriser les scripts utilisateur ». Si cette option n'existe pas chez toi, active le « Mode développeur » en haut à droite de la page des extensions. Rien à faire sur Zen ou Firefox.
3. **Ouvre ce lien** : [installer le script](https://raw.githubusercontent.com/Couvbat/wikimasters-stats/main/wikimasters-stats.user.js). Tampermonkey affiche une page d'installation : clique sur « Installer ».
4. Recharge wiki-masters.com (F5). Le bouton « 📊 Stats » apparaît en bas à droite.

### Mises à jour

Installé par ce lien, le script se met à jour tout seul : Tampermonkey vérifie régulièrement s'il existe une version plus récente. Pour forcer la vérification : tableau de bord Tampermonkey, puis « Rechercher des mises à jour » dans le menu de l'extension.

**Si tu avais installé le script en le collant à la main**, il ne se mettra pas à jour : supprime-le du tableau de bord Tampermonkey, puis réinstalle-le avec le lien ci-dessus. Tes données ne sont pas perdues, elles sont rangées par le site et non par le script.

### Installation manuelle

Si le lien ne fonctionne pas : icône Tampermonkey, « Créer un nouveau script », efface tout, colle le contenu de `wikimasters-stats.user.js`, puis Ctrl+S. Cette méthode ne donne pas de mises à jour automatiques.

Violentmonkey devrait aussi convenir, mais le script n'a pas été testé avec.

### Si le bouton n'apparaît pas

- Sur Chrome, revérifie l'étape 2 : c'est la cause la plus fréquente.
- Dans le tableau de bord de l'extension, « WikiMasters – Stats de collection » doit être dans la liste, avec son interrupteur allumé. S'il n'y est pas, le script n'a pas été enregistré : réinstalle-le avec le lien ci-dessus.
- Sur le site, l'icône de l'extension doit afficher un petit « 1 ». Sinon, recharge la page.

## Utiliser

Le panneau a dix onglets. Dans tous les tableaux, un clic sur un en-tête de colonne trie selon cette colonne, et un second clic inverse le sens.

**Survole un bouton, une case ou un petit « ? »** : une bulle explique ce qu'il fait. Les boutons sont regroupés par rôle, et les options moins utiles sont rangées dans des sections repliables.

### Accueil

L'essentiel en une page, à l'ouverture du panneau : une rangée de chiffres clés (valeur et variation, cartes, places de vente libres, revenus de la semaine, bonnes affaires), puis des blocs. Un bloc « À vérifier » apparaît en tête quand les chiffres risquent d'être faux : collection pas rechargée depuis plus d'un jour, ou cartes L, UR, SR sans prix relevé. Ensuite : valeur de la collection et variation depuis le dernier relevé, les cartes à vendre en premier avec tes places libres, tes souhaits en vente (bonnes affaires d'abord, puis ceux qui finissent bientôt), ton dernier booster et tes dernières enchères. Chaque bloc a un lien « voir → » vers son onglet.

### Collection

- **Charger ma collection** : lit toute ta collection (une dizaine de requêtes, comme quand tu feuillettes les pages).
- **Compléter les prix manquants** (compte Pro uniquement) : va chercher l'historique des ventes des raretés cochées, une carte par seconde, avec un bouton Stop. Un prix relevé est gardé 24 h. Il arrive que le site réponde « aucune vente » pour une carte qui en a : pour les raretés L, UR, SR et R, une réponse vide est donc redemandée une fois, et n'est gardée qu'une heure.
- **Relever les fins d'enchères** : lit les 500 enchères sur le point de se terminer, pour enregistrer leur prix (voir « Prix observés » plus bas). Le script enregistre aussi tout seul ce que tu vois en parcourant la page Marché du site.
- **Chercher mes cartes sur le marché** : cherche les cartes des raretés cochées pour voir qui les vend en ce moment et à quel prix, dans la colonne « En vente à ». Elle traite toutes les cartes d'un coup, une par seconde, et saute celles cherchées depuis moins d'une heure.
- **Rafraîchir les annonces** : relit le prix et la fin des annonces déjà affichées dans cette colonne, sans attendre.
- **Exporter en CSV** : le tableau tel qu'il est filtré et trié, à ouvrir dans Excel ou LibreOffice.
- Clique sur un en-tête de colonne pour trier.

### À vendre

La liste des cartes qui méritent une place aux enchères, les plus chères d'abord. Tu règles la valeur minimale, et tu choisis d'inclure ou non tes favoris et les prix douteux (inclus par défaut : décoche la case pour ne garder que les prix fiables ou moyens). La case « Doublons d'abord » fait passer devant les cartes que tu as en plusieurs exemplaires. Les cartes déjà en vente sont retirées, et les lignes surlignées tiennent dans tes places de vente libres.

La colonne « Concurrence » montre l'annonce la moins chère d'un autre joueur sur la même carte (bouton « Chercher la concurrence »). Le prix conseillé reste la médiane des ventes : une mise de départ ou une offre en cours n'est pas un prix final, donc le script ne s'aligne jamais dessus. Une étiquette « concurrent à X ₩ » signale seulement un concurrent qui a déjà reçu une offre sous la médiane. Tes propres annonces ne comptent pas comme concurrence.

Un clic sur le nom d'une carte ouvre, dans un nouvel onglet, la page Collection du site avec le formulaire « Mettre aux enchères » de cette carte déjà ouvert. Le script s'arrête là : la mise de départ, la durée et le bouton « Lancer l'enchère » restent à toi.

### Mes ventes

Le bilan de tes enchères : ventes réussies et invendus, revenus, achats, solde, détail par rareté, et comparaison entre mise de départ et prix obtenu. Le site ne donne que tes enchères les plus récentes ; le script les garde en mémoire à chaque passage sur la page Marché, donc le bilan s'allonge avec le temps.

### Échanges

Le bilan de tes échanges avec d'autres joueurs : échanges conclus, refusés et contre-proposés, cartes données et reçues, et bilan en valeur. Deux tableaux détaillent avec qui tu échanges et ce que tu donnes et reçois par rareté. Dans la liste, un clic sur un échange le déplie pour montrer les cartes de chaque côté.

Les échanges sont lus sur la page Échanges du site, à chaque visite ou avec le bouton « Actualiser mes échanges », et gardés en mémoire. Les valeurs sont celles d'aujourd'hui, pas celles du jour de l'échange.

Une carte que tu as donnée n'est plus dans ta collection, donc l'onglet Collection ne relève jamais son prix. Le bouton « Relever les prix des cartes échangées » (compte Pro) le fait pour toutes les cartes passées dans tes échanges. Tant qu'une carte n'a pas de prix connu, elle n'est pas comptée : elle apparaît comme « + 1 ? » et le bilan est marqué incomplet, plutôt que d'afficher une valeur inventée.

### Souhaits

Ta liste de souhaits est celle du site : les cartes pour lesquelles tu as demandé une alerte dans « Toutes les cartes ». Clique sur « Charger ma liste de souhaits » pour la lire.

Le marché compte des milliers d'enchères, donc le script ne le parcourt pas en entier. Il retient à la place les alertes de mise en vente que le site t'envoie pour ces cartes. « Vérifier les annonces signalées » cherche chacune d'elles sur le marché par son titre, et affiche le prix le plus bas, la fin de l'enchère et si une offre a déjà été faite. C'est une recherche par seconde, avec un bouton Stop. Les enchères terminées sont retirées.

« Rafraîchir les annonces » relit le prix et la fin des annonces déjà listées, sans attendre : utile avant d'enchérir, puisque les offres montent.

**Bonnes affaires** : une annonce au moins 30 % sous la valeur médiane de la carte (sur 3 ventes ou plus) porte une étiquette verte « bonne affaire −40 % » et remonte en tête. Une case filtre sur elles seules. Pour qu'elles soient repérées, il faut la valeur médiane : « Relever les prix des souhaits en vente » (compte Pro) la relève pour les seuls souhaits actuellement en vente.

Les alertes de plus de 12 h sont ignorées : une enchère dure 12 h au plus, elles concernent donc forcément une vente terminée.

« Chercher mes souhaits sur le marché » fait la même recherche pour toutes les cartes de ta liste, qu'il y ait eu une alerte ou non. Elle traite toute la liste d'un coup, en commençant par celles jamais cherchées. Choisis une rareté pour cibler. Une carte cherchée depuis moins d'une heure est sautée.

Chaque carte a une ligne. Quand elle est mise en vente plusieurs fois, la ligne porte une étiquette « 3 annonces » et décrit une seule de ces annonces, prix et fin d'enchère ensemble. Laquelle dépend du tri : la moins chère par défaut (« dès 30 ₩ »), la plus chère si tu tries par prix décroissant (« jusqu'à 120 ₩ »), celle qui finit le plus tôt ou le plus tard si tu tries par fin d'enchère. Le lien du prix mène à cette annonce-là. Un clic sur la ligne la déplie pour montrer chaque annonce avec son prix, sa fin et son lien ; un second clic la replie. Le bouton « Tout déplier » ouvre toutes les cartes d'un coup. Dans l'onglet Collection, la colonne « En vente à » affiche la moins chère suivie du nombre d'annonces entre parenthèses.

La case « Cacher les cartes que je possède déjà » retire de la liste les souhaits déjà présents dans ta collection, et les exclut aussi de la recherche sur le marché. Elle s'appuie sur la collection chargée dans l'onglet Collection, et reste cochée d'une visite à l'autre. Sans elle, ces cartes portent une étiquette « possédée ».

Le prix d'une annonce est un lien : un clic ouvre cette enchère sur le site, dans un nouvel onglet. Une alerte pas encore vérifiée a aussi son lien.

L'onglet indique aussi si un ami possède la carte, d'après les fichiers importés dans l'onglet Amis.

### Boosters

Chaque paquet que tu ouvres toi-même est mémorisé : nombre de boosters, part de chaque rareté, valeur moyenne par booster, meilleurs tirages. Seuls les boosters ouverts depuis l'installation de la version 1.3 sont comptés.

Avec un compte Pro, un petit panneau affiche aussi, juste après l'ouverture, le prix de chaque carte tirée et un conseil. Une case dans l'onglet Collection permet de le désactiver.

### Évolution

Une courbe de la valeur totale, du nombre de cartes ou du nombre de cartes déjà vendues, avec un point par jour où ta collection a été chargée ou consultée. Elle apparaît à partir du deuxième jour.

### Amis

1. Écris ton pseudo et clique sur « Exporter ma collection pour mes amis ».
2. Envoie le fichier à un ami, et demande-lui le sien.
3. Importe son fichier : tu vois ce qu'il a et que tu n'as pas, ce que tu as et qu'il n'a pas, avec les doublons en tête.

Si vos listes de souhaits sont chargées, l'onglet montre aussi les cartes que tu cherches et qu'il possède, et celles qu'il cherche et que tu possèdes.

Le fichier contient la liste des cartes, leur nombre d'exemplaires, la liste de souhaits et les prix observés. Il ne contient jamais l'historique réservé au Pro, et il fonctionne avec ou sans compte Pro.

### Sauvegarde

Tes données sont rangées dans le navigateur, donc Chrome et Zen ont chacun les leurs. « Exporter toutes mes données » crée un fichier à importer dans l'autre navigateur. L'import fusionne : il ajoute ce qui manque et ne remplace un prix ou une collection que par plus récent. Garde ce fichier pour toi, il contient des prix issus de ton compte.

## Comment lire les chiffres

- **Valeur** : médiane des 10 dernières ventes de la carte.
- **En italique** : carte sans vente connue, comptée à 1 wikibidou. C'est ce que rapporte la défausse, donc le minimum qu'une carte puisse valoir.
- **Cartes déjà vendues aux enchères** : le nombre de tes cartes pour lesquelles au moins une vente est connue.
- **Sans vente connue, comptées à 1** : les autres, et la part de la valeur totale qu'elles représentent. Beaucoup de cartes peuvent être dans ce cas tout en pesant très peu dans le total.
- **Fiabilité** : « Fiable » à partir de 5 ventes dont la dernière a moins de 30 jours, « Moyen » à partir de 2 ventes dont la dernière a moins de 90 jours, « Douteux » sinon. Un écart de plus de 5 entre la vente la plus basse et la plus haute fait descendre d'un cran. La flèche indique si les ventes récentes sont plus hautes ou plus basses que les anciennes. Survole le mot pour le détail.
- **Conseil** : « Vendre » si la valeur dépasse 1 wikibidou (ce que rapporte la défausse), sinon « Défausser ».
- **En vente à** : le prix d'une enchère en cours sur la même carte. Un point signale qu'elle a déjà reçu une offre. Ce prix est indicatif et n'entre pas dans la valeur.
- **Enchères avec offre en ce moment** : le prix médian, par rareté, des enchères en cours qui ont reçu au moins une offre.

## Prix observés

L'historique des ventes d'une carte est une fonction Pro du site. Pour que tout le monde ait des prix, le script construit son propre historique à partir de ce que n'importe quel compte peut voir : les enchères en cours.

- Chaque enchère vue (en parcourant le marché, avec « Relever les fins d'enchères », ou pendant une recherche) est suivie jusqu'à sa fin.
- Quand elle se termine, la dernière offre vue devient un « prix observé » pour cette carte. Une enchère finie sans offre ne donne rien.
- C'est un minimum : l'offre a pu monter après la dernière fois que le script l'a vue. Un prix observé n'est donc jamais noté « Fiable », et son origine est indiquée au survol de la fiabilité.
- « Relever les fins d'enchères » est le moyen le plus précis, puisqu'il lit les enchères dans leur dernière minute.

Ces prix servent de valeur pour une carte quand il n'y a ni historique Pro ni vente personnelle. Ils donnent aussi un niveau de prix par rareté, affiché en haut de l'onglet Collection.

Les prix observés partent dans le fichier que tu exportes pour tes amis, et ceux de tes amis s'ajoutent aux tiens à l'import : à plusieurs, l'historique se remplit plus vite. L'historique réservé au Pro, lui, n'est jamais partagé.

La couverture reste partielle. Il existe près de trois millions de cartes, et le script ne connaît que les enchères qu'il a vues passer : ne compte pas dessus pour avoir le prix de chaque carte.

## Compte non Pro

L'historique des ventes de chaque carte est une fonction Pro du site, et le script n'y touche pas sans compte Pro. Il reste :

- les prix observés décrits ci-dessus ;

- le tableau (rareté, ATK, DEF, Q-Score, vues, exemplaires) et l'export CSV ;
- les stats de boosters, le bilan de tes ventes, la liste de souhaits, l'évolution, la comparaison entre amis et la sauvegarde ;
- le niveau de prix par rareté, d'après les enchères en cours ;
- une valeur pour les cartes que tu as toi-même vendues ou achetées, lue dans ton historique sur la page Marché.

Les autres cartes sont comptées à 1.

## À savoir

Les règles de WikiMasters interdisent les scripts qui jouent ou interagissent à ta place. Celui-ci se limite à lire des données que le site t'affiche déjà, mais c'est toi qui choisis de l'utiliser sur ton compte.

## Rythme des requêtes

Les traitements longs (prix, recherches sur le marché, annonces) n'ont plus de plafond : un clic traite toute la liste, à raison d'une requête par seconde, avec le temps restant estimé et un bouton Stop.

Si le site demande de ralentir, le script fait une pause (le délai indiqué par le site, sinon 15 s, puis de plus en plus long), ralentit la suite, et reprend tout seul au même endroit. Il n'essaie pas de contourner cette limite : c'est la protection du site, et ses règles interdisent les outils qui jouent à ta place.

Compte une quinzaine de minutes pour chercher toute une collection de 800 cartes.
