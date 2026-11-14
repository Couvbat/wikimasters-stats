# WikiMasters – Stats de collection

Un bouton « 📊 Stats » ajouté sur wiki-masters.com : tableau de ta collection, valeur des cartes, conseil vendre ou défausser, export CSV.

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

- **Charger ma collection** : lit toute ta collection (une dizaine de requêtes, comme quand tu feuillettes les pages).
- **Compléter les prix manquants** (compte Pro uniquement) : va chercher l'historique des ventes des raretés cochées, une carte par seconde, avec un bouton Stop. Un prix relevé est gardé 24 h.
- **Après un booster** (compte Pro uniquement) : quand tu ouvres toi-même un paquet, un petit panneau affiche pour chaque carte tirée son prix médian et un conseil. La case à cocher dans le panneau Stats permet de le désactiver.
- **Exporter en CSV** : le tableau tel qu'il est filtré et trié, à ouvrir dans Excel ou LibreOffice.
- Clique sur un en-tête de colonne pour trier.

## Comment lire les chiffres

- **Valeur** : médiane des 10 dernières ventes de la carte.
- **En italique** : carte sans vente connue, comptée à 1 wikibidou. C'est ce que rapporte la défausse, donc le minimum qu'une carte puisse valoir.
- **Dont sans vente connue** : la part de la valeur totale qui vient de ces cartes comptées à 1.
- **Conseil** : « Vendre » si la valeur dépasse 1 wikibidou (ce que rapporte la défausse), sinon « Défausser ».

## Compte non Pro

L'historique des ventes est une fonction Pro du site. Sans compte Pro, le script n'y touche pas : tu as le tableau (rareté, ATK, DEF, Q-Score, vues, exemplaires) et l'export CSV, mais pas les valeurs ni le panneau après booster.

## À savoir

Les règles de WikiMasters interdisent les scripts qui jouent ou interagissent à ta place. Celui-ci se limite à lire des données que le site t'affiche déjà, mais c'est toi qui choisis de l'utiliser sur ton compte.
