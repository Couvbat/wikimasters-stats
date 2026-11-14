# WikiMasters – Stats de collection

Un bouton « 📊 Stats » ajouté sur wiki-masters.com : valeur de ta collection, cartes à vendre en priorité, stats de boosters, comparaison entre amis, export CSV.

Le script ne fait que lire. Il n'ouvre pas de paquet, ne met rien aux enchères, n'échange rien et ne défausse rien. Les données restent dans ton navigateur.

## Installer

Testé avec Tampermonkey sur Chrome et sur Zen.

### Sur Chrome

1. Installe **Tampermonkey** depuis le Chrome Web Store.
2. **Autorise les scripts utilisateur, sinon rien ne se lance.** Ouvre `chrome://extensions`, clique sur « Détails » de Tampermonkey et active « Autoriser les scripts utilisateur ». Si cette option n'existe pas chez toi, active le « Mode développeur » en haut à droite de la page des extensions.
3. Clique sur l'icône Tampermonkey, puis « Créer un nouveau script ».
4. Efface tout ce qui est dans l'éditeur, colle le contenu de `wikimasters-stats.user.js`, puis enregistre avec Ctrl+S.
5. Recharge wiki-masters.com (F5). Le bouton « 📊 Stats » apparaît en bas à droite.

### Sur Zen ou Firefox

1. Installe **Tampermonkey** depuis addons.mozilla.org.
2. Clique sur l'icône Tampermonkey, puis « Créer un nouveau script ».
3. Efface tout ce qui est dans l'éditeur, colle le contenu de `wikimasters-stats.user.js`, puis enregistre avec Ctrl+S.
4. Recharge wiki-masters.com (F5). Le bouton « 📊 Stats » apparaît en bas à droite.

Il n'y a rien à autoriser sur Zen ou Firefox : l'étape « Autoriser les scripts utilisateur » ne concerne que Chrome.

Violentmonkey devrait aussi convenir (bouton « + », puis « Nouveau script »), mais le script n'a pas été testé avec.

### Si le bouton n'apparaît pas

- Sur Chrome, revérifie l'étape 2 : c'est la cause la plus fréquente.
- Dans le tableau de bord de l'extension, « WikiMasters – Stats de collection » doit être dans la liste, avec son interrupteur allumé. S'il n'y est pas, le script n'a pas été enregistré : recolle-le et refais Ctrl+S.
- Sur le site, l'icône de l'extension doit afficher un petit « 1 ». Sinon, recharge la page.

## Utiliser

Le panneau a huit onglets.

### Collection

- **Charger ma collection** : lit toute ta collection (une dizaine de requêtes, comme quand tu feuillettes les pages).
- **Compléter les prix manquants** (compte Pro uniquement) : va chercher l'historique des ventes des raretés cochées, une carte par seconde, avec un bouton Stop. Un prix relevé est gardé 24 h.
- **Relever le marché** : lit les 4 premières pages d'enchères en cours. Le script les lit aussi tout seul quand tu ouvres la page Marché du site.
- **Exporter en CSV** : le tableau tel qu'il est filtré et trié, à ouvrir dans Excel ou LibreOffice.
- Clique sur un en-tête de colonne pour trier.

### À vendre

La liste des cartes qui méritent une place aux enchères : doublons d'abord, puis les plus chères. Tu règles la valeur minimale, et tu choisis d'inclure ou non tes favoris et les prix douteux. Les cartes déjà en vente sont retirées, et les lignes surlignées tiennent dans tes places de vente libres. Le script ne met rien en vente : c'est toi qui le fais sur le site.

### Mes ventes

Le bilan de tes enchères : ventes réussies et invendus, revenus, achats, solde, détail par rareté, et comparaison entre mise de départ et prix obtenu. Le site ne donne que tes enchères les plus récentes ; le script les garde en mémoire à chaque passage sur la page Marché, donc le bilan s'allonge avec le temps.

### Souhaits

Ta liste de souhaits est celle du site : les cartes pour lesquelles tu as demandé une alerte dans « Toutes les cartes ». Clique sur « Charger ma liste de souhaits » pour la lire.

Le marché compte des milliers d'enchères, donc le script ne le parcourt pas en entier. Il retient à la place les alertes de mise en vente que le site t'envoie pour ces cartes. « Vérifier les annonces signalées » cherche chacune d'elles sur le marché par son titre, et affiche le prix le plus bas, la fin de l'enchère et si une offre a déjà été faite. C'est une recherche par seconde, 40 au plus par passage, avec un bouton Stop. Les enchères terminées sont retirées.

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

Le fichier contient la liste des cartes, leur nombre d'exemplaires et la liste de souhaits, sans aucun prix. Il fonctionne avec ou sans compte Pro.

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

## Compte non Pro

L'historique des ventes de chaque carte est une fonction Pro du site, et le script n'y touche pas sans compte Pro. Il reste :

- le tableau (rareté, ATK, DEF, Q-Score, vues, exemplaires) et l'export CSV ;
- les stats de boosters, le bilan de tes ventes, la liste de souhaits, l'évolution, la comparaison entre amis et la sauvegarde ;
- le niveau de prix par rareté, d'après les enchères en cours ;
- une valeur pour les cartes que tu as toi-même vendues ou achetées, lue dans ton historique sur la page Marché.

Les autres cartes sont comptées à 1.

## À savoir

Les règles de WikiMasters interdisent les scripts qui jouent ou interagissent à ta place. Celui-ci se limite à lire des données que le site t'affiche déjà, mais c'est toi qui choisis de l'utiliser sur ton compte.
