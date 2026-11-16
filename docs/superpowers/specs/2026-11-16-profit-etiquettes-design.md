# Profit des ventes et étiquetage par lots — conception (courte, approuvée par Jules)

## 1. Profit des ventes (livré en premier)

**Pourquoi.** Dans Mes ventes, Jules veut voir ce que chaque carte lui rapporte : son prix de vente moins ce qu'elle lui a coûté (achetée, tirée d'un booster, reçue par échange).

**Origine d'une carte** (`originOf(carte, rareté, shiny, avant)`) : la dernière acquisition de cette carte, à cette rareté (ou à rareté inconnue), datée avant la mise en vente.

| Origine | Source | Coût |
|---|---|---|
| achetée aux enchères | `db.auctions`, type `b`, prix final, même statut shiny | le prix payé |
| tirée d'un booster | `db.pulls` | 0 ₩ |
| reçue par échange accepté | `db.trades`, côté reçu | ≈ (valeur actuelle des cartes données + wikibidous donnés − reçus) ÷ nombre de cartes reçues, au moins 0 |
| inconnue | — | « origine inconnue » |

- **Date de mise en vente** : `created_at` de l'annonce, nouveau champ `at` de `db.selling`. Pour une vente terminée, on prend sa date de règlement.
- **Ventes en cours** :
  - colonnes **Origine** et **Profit** (prix actuel moins coût, avec « ≈ » pour un échange) ;
  - tuile « Profit si tout part maintenant », sur les annonces d'origine connue.
- **Ventes terminées** : colonne **Profit** pour les ventes réussies, et une ligne qui totalise les profits connus.
- **Commission** : aucune n'apparaît dans les données du site, donc le profit est calculé sans commission.

## 2. Étiquetage par lots (livré ensuite)

**Pourquoi.** Ranger sa collection avec ses propres étiquettes, sans le faire carte par carte, en gardant la main sur chaque lot.

**Fait vérifié le 16/11, en lecture seule.** Le site écrit les étiquettes directement dans sa base Supabase. Il ajoute une ligne `{ user_card_id, tag_id }` dans `user_card_tags`, ou plusieurs en une seule requête (upsert) quand on étiquette en mode « Sélectionner ». Les étiquettes `{ id, user_id, name, color }` sont dans la table `tags`.

**Fonctionnement :**
- Dans l'onglet Collection, un groupe « Étiquetage par lots ». Tu choisis une règle et l'une de tes étiquettes existantes : le script n'en crée et n'en supprime aucune. Les règles :
  - les cartes de la liste À vendre ;
  - les cartes qui valent 1 ₩ ;
  - les doublons ;
  - une rareté ;
  - une valeur au-dessus de N ₩.
- Un aperçu montre le lot : les exemplaires qui n'ont pas encore cette étiquette, 200 au plus.
- Un clic, puis un second pour confirmer, applique le lot en **une seule requête**, comme le fait le site. Le script ne fait qu'ajouter.
- Toute erreur, `automation_limit` compris, arrête tout. Rien ne part sans un clic.
- Le script a besoin de l'identifiant des étiquettes : il garde le catalogue `{ id, name, color }` lu dans la collection.
- **Avant de publier** : un essai réel sur une carte choisie par Jules.

**Approche écartée** : faire cliquer le script dans le mode « Sélectionner » du site. Ça casse à chaque mise à jour du site, et c'est plus lent.
