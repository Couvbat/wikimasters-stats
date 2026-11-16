# Plus de prix pour les comptes sans Pro

## Pourquoi

L'extension doit rester utile aux amis qui n'ont pas de compte Pro. Sans Pro, le site refuse l'historique des ventes (403 `pro_required`). Il reste les enchères du Marché et la page de chaque enchère, qui donne le prix final une fois réglée.

Constaté le 16/11/2026 avec un compte normal :
- plusieurs centaines d'enchères se terminent en quelques minutes, la moitié avec une offre ;
- la dernière offre visible ne suffit pas : 2 enchères terminées sur 4 ont encore monté avant d'être réglées ;
- le Marché accepte un filtre `rarity` (L, UR, SR…) avec le tri `ending_soon`.

Le frein est donc la relecture des prix finaux, une requête par seconde. Il faut choisir les bonnes enchères à relire.

## A. Relire d'abord ce qui compte

- **Ordre des prix finaux** (`finalsToFetch`) :
  1. les cartes de ta collection ou de ta liste de souhaits ;
  2. puis par rareté : L, UR, SR, R, PC, C ;
  3. puis les enchères qui avaient une offre ;
  4. puis les plus récentes.
- **Enchère inutile** : retirée de la file quand sa carte a déjà 10 prix observés, tous plus récents que la fin de cette enchère. Son prix serait écarté de toute façon.
- **« Relever les fins d'enchères »** : en plus des 10 pages actuelles, elle lit 3 pages de chaque rareté L, UR et SR (`&rarity=`). Cela fait 19 requêtes au lieu de 10.
- **Message de fin** de « Relever les prix finaux » : il précise combien de prix concernent tes cartes.

## Protection : la limite d'automatisation du site

Le site répond `code: "automation_limit"` quand il estime qu'un compte va trop vite. C'est visible dans le code de wiki-master-toolkit, une autre extension. Aujourd'hui, `fetchFinals` traite un 403 comme « enchère inaccessible » : il la retire de la file et passe à la suivante.

- `getJSON` lit le corps des réponses en erreur. Si `code === 'automation_limit'`, quel que soit le statut HTTP, l'erreur porte ce code.
- Tout traitement en cours s'arrête aussitôt, sans retirer l'enchère de la file, avec un message clair (« Le site limite les relevés automatiques : réessaie plus tard »).
- Le relevé automatique (B) se met en pause 24 h (`db.autoPauseUntil`).

## B. Relevé automatique (option, désactivée par défaut)

- **Réglage** : une case dans Réglages, groupe « Relevé automatique des prix (tous comptes) ».
- **Quand** : toutes les 30 minutes, si l'onglet du site est affiché à l'écran (pas en arrière-plan). Le premier passage a lieu 2 minutes après l'ouverture de la page.
- **Un passage** :
  1. d'abord les prix finaux en attente, dans l'ordre de A, 60 au plus (le site détecte l'automatisation : on reste modeste, environ 160 requêtes par heure au maximum) ;
  2. puis un relevé des fins d'enchères (les 19 pages de A), qui prépare le passage suivant.
- **Rythme** : une requête par seconde. Le passage s'arrête dès qu'un autre relevé démarre, que le site demande de ralentir ou qu'une erreur survient, et reprend au passage suivant. Une limite d'automatisation le met en pause 24 h. Il ne bloque pas les boutons.
- **Un seul onglet à la fois** : un verrou dans `localStorage` (clé à part) garantit qu'un seul onglet relève, et l'intervalle de 30 minutes est commun à tous les onglets.
- **Affichage** : sous la case, « Dernier relevé automatique : il y a X min, N prix finaux ».

## Hors champ

- Pas de paramètre caché ni de route non utilisée par le site : on ne lit que ce qu'un compte normal voit en naviguant.
- Pas de relevé quand l'onglet est en arrière-plan ou fermé.

## Livraison

Même branche et même PR (Couvbat/wikimasters-stats#1). Le thème est le même : des prix sans compte Pro. La version reste 1.19.0, puisque rien n'est encore publié. README et tests mis à jour.

## Approches envisagées

- **A seul** : même nombre de requêtes, des prix plus utiles, mais il faut toujours cliquer.
- **A puis B (choisie)** : les amis sans Pro accumulent des prix sans rien faire. B sans A gaspillerait ses requêtes sur des cartes sans importance.
