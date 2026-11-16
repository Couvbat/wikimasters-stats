# Guide pas à pas (pas besoin d'être développeur)

Ce guide t'accompagne de bout en bout :
1. récupérer le dossier du projet ;
2. installer l'extension ;
3. la relier au pool de prix du groupe ;
4. t'en servir au quotidien.

Compte environ 15 minutes. Le guide est écrit pour **Windows + Chrome**, et les différences pour Firefox ou Zen sont signalées au passage.

**Ce qu'il te faut**

- Un PC Windows.
- Chrome, Firefox ou Zen.
- Ton compte WikiMasters.
- Pour l'étape 4 : l'**adresse** et la **clé** du pool, que Jules t'envoie en message privé.

**Sommaire**

1. [Récupérer le dossier du projet](#1-récupérer-le-dossier-du-projet)
2. [Installer Tampermonkey](#2-installer-tampermonkey)
3. [Installer le script](#3-installer-le-script)
4. [Relier le pool de prix du groupe](#4-relier-le-pool-de-prix-du-groupe)
5. [Premiers pas](#5-premiers-pas)
6. [Au quotidien](#6-au-quotidien)
7. [Si quelque chose ne marche pas](#7-si-quelque-chose-ne-marche-pas)

---

## 1. Récupérer le dossier du projet

Le dossier contient ce guide et le petit programme du pool de prix (étape 4).

1. Ouvre la page du projet : <https://github.com/Couvbat/wikimasters-stats>.
2. Clique sur le bouton vert **« Code »**, puis sur **« Download ZIP »**. Le fichier `wikimasters-stats-main.zip` arrive dans ton dossier **Téléchargements**.
3. Dans Téléchargements, fais un **clic droit** sur ce fichier, puis **« Extraire tout… »**, puis **« Extraire »**.
4. Déplace le dossier obtenu, `wikimasters-stats-main`, où tu veux. Par exemple dans **Documents**.

✅ **Tu dois voir** un dossier `wikimasters-stats-main` qui contient, entre autres, `GUIDE.md`, `wikimasters-stats.user.js` et un dossier `server`.

---

## 2. Installer Tampermonkey

Tampermonkey est l'extension du navigateur qui fait tourner le script sur le site.

1. **Chrome** : ouvre la [page Tampermonkey du Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo), clique **« Ajouter à Chrome »**, puis **« Ajouter l'extension »**.
   **Firefox ou Zen** : ouvre la [page Tampermonkey de Firefox](https://addons.mozilla.org/fr/firefox/addon/tampermonkey/), clique **« Ajouter à Firefox »**, puis **« Ajouter »**.
2. **Chrome seulement, et c'est l'étape la plus souvent oubliée** :
   1. tape `chrome://extensions` dans la barre d'adresse, puis Entrée ;
   2. sur la carte **Tampermonkey**, clique **« Détails »** ;
   3. active **« Autoriser les scripts utilisateur »**.

   Si cette option n'existe pas, active d'abord le **« Mode développeur »**, en haut à droite de la page, puis reviens dans « Détails ».
3. Conseil : épingle l'icône. Clique sur la **pièce de puzzle** à droite de la barre d'adresse, puis sur la **punaise** à côté de Tampermonkey.

✅ **Tu dois voir** l'icône de Tampermonkey (un carré noir avec deux ronds) à droite de la barre d'adresse.

---

## 3. Installer le script

1. Clique sur ce lien : **[installer le script](https://raw.githubusercontent.com/Couvbat/wikimasters-stats/main/wikimasters-stats.user.js)**.
2. Tampermonkey ouvre une page avec un bouton **« Installer »** : clique dessus.
3. Va sur [wiki-masters.com](https://www.wiki-masters.com), connecte-toi, puis appuie sur **F5** pour recharger la page.

✅ **Tu dois voir** un bouton **« 📊 Stats »** en bas à droite de l'écran, sur toutes les pages du site.

> Installe-le bien **par ce lien**, et non à partir du fichier du dossier : c'est ce qui permet au script de **se mettre à jour tout seul**.

---

## 4. Relier le pool de prix du groupe

Le **pool**, c'est la base où tout le groupe met ses prix en commun. Ce que l'un relève sert à tous, même sans compte Pro, et chacun fait moins de requêtes au site.

Le pool est **facultatif** : sans lui, l'extension marche très bien. Elle a seulement moins de prix.

### Cas A : Jules t'a donné une adresse qui commence par `https://`

C'est le pool du groupe, sur le NAS de Jules.

1. Clique sur **📊 Stats**, puis sur l'onglet **Réglages**, puis trouve le groupe **« Pool partagé du groupe »**.
2. Colle l'**adresse** dans la première case, et la **clé** dans la seconde.
3. Clique **« Tester »**.
4. Coche **« Partager et recevoir les prix »**.

✅ **Tu dois voir**, après « Tester », un message du genre « Connecté : 1 234 ventes, 567 cartes, 4 membres ».

> **Garde la clé pour toi** : ne la publie nulle part, et ne la mets pas dans une capture d'écran.

### Cas B : en attendant le NAS, le pool sur ton PC (temporaire)

Tant que le pool du NAS n'est pas en ligne, tu peux en faire tourner un **sur ton PC**. Tes prix s'y accumulent, et ils **partiront vers le NAS** le jour où il sera prêt (voir plus bas). Si tu préfères attendre le NAS, saute ce cas.

**a. Installer Node.js** (une seule fois)

1. Va sur <https://nodejs.org> et clique sur le gros bouton de téléchargement de la version **LTS**.
2. Ouvre le fichier téléchargé, puis clique **« Suivant »** jusqu'à **« Terminer »**. Laisse toutes les options par défaut, et ne coche pas les « outils pour modules natifs ».

**b. Lancer le pool**

1. Ouvre le dossier `wikimasters-stats-main`, puis le dossier `server`, et **double-clique** sur `start-local.cmd`.
2. Si Windows affiche **« Windows a protégé votre ordinateur »**, clique **« Informations complémentaires »**, puis **« Exécuter quand même »**. C'est normal pour un fichier téléchargé depuis Internet.
3. Une **fenêtre noire** s'ouvre et affiche `Pool local : http://localhost:8787`. **Laisse-la ouverte** pendant que tu joues. Tu peux la réduire, mais pas la fermer.

**c. Le relier au script**

1. Ouvre **Documents**, puis le dossier **`wm-pool`**, et **double-clique** sur `cle.txt`. Il s'ouvre dans le Bloc-notes. Fais **Ctrl+A**, puis **Ctrl+C** : la clé est copiée.
2. Sur le site : **📊 Stats**, puis **Réglages**, puis **« Pool partagé du groupe »**.
3. Adresse : `http://localhost:8787`. Clé : colle-la avec **Ctrl+V**.
4. Clique **« Tester »**, puis coche **« Partager et recevoir les prix »**.
5. Si Chrome te demande si wiki-masters.com peut accéder à d'autres applications de cet appareil, clique **« Autoriser »**. C'est ton pool local.

✅ **Tu dois voir** « Connecté : … » après « Tester ».

> **À chaque fois que tu joues**, lance `start-local.cmd` avant, ou laisse-le tourner. Si la fenêtre noire est fermée, le script continue normalement : il garde ses prix et les enverra quand le pool sera revenu.

### Le jour où le NAS est en ligne (seulement si tu as fait le cas B)

Jules t'envoie l'adresse et la clé du pool du NAS. Il faut alors envoyer ce que ton pool local a accumulé, puis passer au NAS.

1. Ouvre le **Bloc-notes** et écris **sur une seule ligne** l'adresse, **un espace**, puis la clé. Par exemple :
   `https://pool.exemple.fr la-cle-que-jules-ta-donnee`
2. Fais **Fichier**, puis **Enregistrer sous**, et va dans **Documents**, puis **`wm-pool`**.
   - **Type** : choisis **« Tous les fichiers »**. Sinon, Windows enregistre `amont.txt.txt`.
   - **Nom** : `amont.txt`.
   - Clique **Enregistrer**.
3. Ferme la fenêtre noire du pool, puis **relance** `start-local.cmd`. Elle affiche maintenant `Synchro : vers https://…`.
4. Attends quelques minutes, puis ouvre <http://localhost:8787/v1/health> dans ton navigateur. Si tu vois `"err":""` (rien entre les guillemets), c'est envoyé.
5. Dans le script (**Réglages**, puis **« Pool partagé du groupe »**), remplace l'adresse et la clé par **celles du NAS**, puis clique **« Tester »**.
6. Ferme la fenêtre noire : tu n'as plus besoin du pool local, ni de relancer `start-local.cmd`.

---

## 5. Premiers pas

1. **Ton pseudo** : clique sur **📊 Stats**, puis l'onglet **Amis**, et écris ton pseudo dans la case « ton pseudo ». C'est le nom que tes amis verront à côté de tes prix (« relevé partagé par … »).
2. **Ta collection** : onglet **Collection**, bouton **« Recharger ma collection »**. Ça prend une dizaine de secondes.
3. **Les prix** :
   - **avec un compte Pro** : bouton **« Relever les prix »** ;
   - **sans compte Pro** : clique **« Relever les fins d'enchères »**, attends quelques minutes, puis clique **« Relever les prix finaux »**. Pour que ça se fasse tout seul : **Réglages**, puis coche **« Relever les prix en arrière-plan »**.
4. **Fais le tour des onglets** :

   | Onglet | À quoi il sert |
   |---|---|
   | **Accueil** | L'essentiel en une page. |
   | **Collection** | La valeur de chaque carte. |
   | **À vendre** | Quoi mettre aux enchères en priorité. |
   | **Mes ventes** | Tes ventes en cours (avec le profit) et terminées. |
   | **Souhaits** | Les bonnes affaires sur ta liste de souhaits. |
   | **Boosters** | Ce que rapportent tes paquets. |
   | **Amis** | Comparer et préparer des échanges. |

5. **Sur le site lui-même**, chaque carte dont le prix est connu porte une **petite pastille** avec sa valeur. Survole-la pour le détail.

> **Astuce** : survole n'importe quel bouton ou petit **« ? »**. Une bulle explique ce qu'il fait.

---

## 6. Au quotidien

- **Avant d'ouvrir tes paquets**, vérifie que le bouton **📊** est là. Sinon, appuie sur **F5**. Le script ne compte un booster que s'il tourne au moment où tu l'ouvres.
- **Passe sur la page Marché** de temps en temps. Le script y lit tes ventes, tes achats et tes enchères en cours.
- **Recharge ta collection** une fois par jour : onglet Collection, puis « Recharger ma collection ».
- **Les mises à jour sont automatiques**, une fois par jour. Pour ne pas attendre : **Réglages**, puis **« Vérifier »**, puis **« Installer la dernière version »**, puis **« Mettre à jour »** sur la page de Tampermonkey. Recharge ensuite le site.
- **Avec le pool sur ton PC (cas B)** : lance `start-local.cmd` avant de jouer.

---

## 7. Si quelque chose ne marche pas

**Le bouton 📊 n'apparaît pas**

- Sur Chrome, revérifie l'**étape 2.2** (« Autoriser les scripts utilisateur ») : c'est la cause la plus fréquente.
- Appuie sur **F5**.
- Clique sur l'icône de Tampermonkey. « WikiMasters – Stats de collection » doit y être, avec son interrupteur **allumé**. S'il n'y est pas, refais l'**étape 3**.

**« Tester » affiche une erreur**

- **Pool sur ton PC** : la fenêtre noire est-elle ouverte ? Sinon, relance `start-local.cmd`.
- Vérifie l'**adresse** et la **clé** : aucun espace au début ni à la fin.
- « clé refusée » : la clé n'est pas la bonne. Recopie-la.
- **Chrome a bloqué l'accès local** : clique sur l'icône à gauche de l'adresse du site, puis autorise l'accès aux applications de l'appareil, et recharge.
- **Pool du NAS** : il n'est peut-être pas encore en ligne. Demande à Jules.

**La fenêtre noire se ferme tout de suite, ou dit « Node.js est introuvable »**

- Installe Node.js (cas B, étape a), redémarre le PC, puis relance `start-local.cmd`.

**Une carte affiche « booster probable » dans Mes ventes**

- Le script ne l'a pas vue sortir d'un paquet, parce qu'il ne tournait pas à ce moment-là. Comme elle n'a été ni achetée ni échangée, il en déduit qu'elle vient d'un booster. Pour la suite, vérifie que le bouton 📊 est là avant d'ouvrir tes paquets.

**Le panneau est vide ou dit « Collection pas encore chargée »**

- Onglet Collection, puis **« Recharger ma collection »**.

**Tout désinstaller**

1. Clique sur l'icône de Tampermonkey, puis **« Tableau de bord »**, puis supprime « WikiMasters – Stats de collection ».
2. Supprime le dossier `wikimasters-stats-main`, et `Documents\wm-pool` si tu as fait le cas B.

---

## Ce que le script fait, et ce qu'il ne fait pas

- **Il lit seulement ce que le site t'affiche déjà.** Il n'ouvre pas de paquet, ne mise pas, ne vend rien, n'échange rien et ne défausse rien à ta place.
- **Une seule exception** : l'**étiquetage par lots** (onglet Collection), qui ajoute une de tes étiquettes à des cartes. Il ne le fait qu'après **tes deux clics**.
- **Tes données restent dans ton navigateur.** Si tu actives le pool, seuls des **prix** partent, avec ton pseudo. Jamais ta collection, ta liste de souhaits ou ta clé.

Pour le détail de chaque fonction, voir le [README](README.md).
