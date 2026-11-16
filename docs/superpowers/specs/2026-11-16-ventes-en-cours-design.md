# Mes ventes en cours — conception (courte, approuvée par Jules)

## Pourquoi

L'onglet Mes ventes ne montre que les enchères terminées. Jules veut aussi voir l'état de ses mises en vente **en cours**. Le site envoie déjà toutes leurs informations (`selling` dans la réponse du Marché), mais le script n'en gardait que l'identifiant des cartes.

## Ce qu'on fait

- **Données** : `db.selling`, la liste de tes annonces en cours, propre à chaque compte comme `db.bids`. Pour chaque annonce, on garde :
  - l'enchère, la carte, le titre, la rareté de l'exemplaire ;
  - la mise de départ actuelle et celle d'origine ;
  - l'offre actuelle (ou aucune) et la fin ;
  - si c'est une shiny.

  La liste est remplacée à chaque réponse qui contient `selling` (page Marché du site, bouton « Actualiser »). `db.market.selling` (les identifiants des cartes) reste tel quel pour À vendre et l'Accueil.
- **Bloc « Mes ventes en cours »** en haut de l'onglet Mes ventes, affiché même sans enchère terminée en mémoire.
  - **Tuiles** :
    - en vente, sur le nombre de places, avec les places libres ;
    - avec une offre, et combien dépassent leur mise de départ ;
    - si tout part maintenant : la somme des offres ;
    - valeur de ces cartes : la médiane à la rareté de l'exemplaire, sans les shiny ;
    - sous la valeur : le prix actuel (l'offre, sinon la mise de départ) est inférieur à la valeur.
  - **Tableau** :
    - colonnes : carte (rareté, ✦), mise de départ, offre actuelle (lien vers l'annonce), valeur, écart (prix actuel moins valeur, en vert ou en rouge), fin ;
    - l'étiquette « mise > valeur » apparaît sur une annonce sans offre dont la mise de départ dépasse la valeur ;
    - une annonce shiny n'est pas comparée ;
    - une annonce terminée reste affichée jusqu'à la prochaine mise à jour, mais ne compte plus dans les tuiles.

## Livraison

Branche `claude/ventes-en-cours` depuis `main`, version 1.21.0, PR.
