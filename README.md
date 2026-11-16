# Español diario

Web app (PWA) statique pour apprendre l’espagnol en partant de zéro : chaque jour, les mots fréquents en
révision espacée (FSRS), l’histoire du jour écrite avec ces mots et lue avec l’audio, puis Dreaming Spanish.
Le cahier des charges est dans `SPEC.md`.

## Installer sur iPhone

1. Ouvrir l’adresse de l’appli dans **Safari** (pas Chrome : seul Safari permet l’installation).
2. Toucher **Partager** (carré avec une flèche vers le haut), puis **« Sur l’écran d’accueil »**, puis **Ajouter**.
3. Lancer l’appli depuis l’icône « ñ ». Elle s’ouvre en plein écran et fonctionne hors-ligne.
4. Conseillé, en Wi-Fi : **Réglages › Télécharger tout l’audio pour le hors-ligne**.

L’audio ne démarre qu’après un premier tap (règle d’iOS) ; ensuite les mots se lisent tout seuls.
Le mode **Écoute** utilise le lecteur audio natif : il continue écran verrouillé.

## Sauvegarder sa progression

Tout est enregistré **sur le téléphone** (`localStorage`, clés `ed:v1:*`), rien sur un serveur.
Si on supprime l’appli de l’écran d’accueil ou les données de Safari, la progression est perdue.

- **Réglages › Exporter ma progression** : ouvre le menu de partage d’iOS avec un fichier `.json`
  (à enregistrer dans Fichiers, ou s’envoyer par mail). Si le partage de fichier n’est pas disponible,
  le JSON s’affiche pour être copié.
- **Réglages › Importer** : choisir le fichier, ou coller le texte. L’import remplace la progression actuelle.
- **Rappel** : sur l’écran Aujourd’hui, un bandeau « Sauvegarde ta progression » apparaît si le dernier
  export a plus de 7 jours (ou, sans aucun export, dès 2 jours d’utilisation). « Plus tard » le masque
  3 jours. La date du dernier export est gardée dans `ed:v1:meta`.

## Fonctionnement

- Chaque jour calendaire, un **lot** de nouvelles cartes est débloqué (lot = `days[N]` de `data/days.json`,
  10 mots, fixe). « Jour N » = nombre de lots débloqués. Le lot suivant n’arrive que lorsque les
  nouvelles cartes du lot précédent ont toutes été vues : un jour sauté ne crée pas de retard à rattraper.
- Pas de réglage « nouvelles cartes par jour » : les histoires sont écrites pour les lots de 10 de `days.json`
  (un autre rythme décalerait mots et histoires). Après le jour 60 : le reste du paquet principal.
  Option : 5 cognats transparents par jour (les 5 premiers jamais vus).
- Notation : **À revoir** = FSRS *Again*, **Je savais** = FSRS *Good* (`ts-fsrs`, rétention 0,9,
  apprentissage court terme : une carte ratée revient dans la même séance).
- Une révision due aujourd’hui (quelle que soit l’heure) fait partie de la file du jour.
- **Après une absence** : au plus 60 révisions par jour (Réglages, 30–150), les plus anciennes d’abord ;
  le reste revient les jours suivants (« le reste plus tard »). Tant que plus de 40 révisions sont dues
  ce jour-là, le nouveau lot attend le lendemain (le « Jour N » n’avance pas, aucun jour n’est perdu).
  Message « Bon retour ! » après au moins 2 jours sans activité.
- Série = jours avec une activité (cartes, histoire, Dreaming Spanish ou écoute), avec **un jour manqué
  toléré** : elle ne casse qu’après 2 jours manqués de suite. Elle n’est pas cassée tant que la journée
  n’est pas finie. Si elle casse, l’accueil affiche « Nouvelle série — record : N jours ».
- Accueil : un seul bouton principal (première étape non faite) ; « Journée terminée ✓ » quand Mots,
  Histoire et Dreaming Spanish sont faits. Stat « d’espagnol écouté » = Dreaming Spanish + audio des
  histoires et de l’écoute en trajet. Bandeau d’installation (une fois, refermable) après la première
  séance si l’appli n’est pas lancée depuis l’écran d’accueil.
- Écoute en trajet : cochée après 5 min d’écoute cumulée dans la journée. La semaine W s’ouvre quand tous ses
  lots sont débloqués (jour 7W ; semaine 9 = jours 57–60, au jour 60).
- **Cette semaine** : sous les étapes de l’accueil, une consigne par semaine (`data/weeks.json`, W = ceil(jour/7))
  avec un lien vers la fiche de grammaire ou l’aide. Ce n’est pas une étape : elle ne bloque pas « Journée terminée ».
- **Fiches de grammaire** (`data/grammar.json`, onglet Histoires) : ser/estar (j1), présent et négation (j8),
  gustar (j15), passé (j21). **Réglages › Aide** : deux prompts à copier pour Claude (correction, conversation vocale).
- **Mot jamais vu** : d’abord une découverte (recto et verso, audio) avec un seul bouton « Compris, suivant »
  = FSRS *Again* ; le mot revient quelques minutes plus tard pour être vérifié normalement.
- **Compteurs en mots** : accueil « 10 nouveaux mots · 5 à revoir · ≈ 4 min » ; pendant la séance, barre
  de progression + « Reste ≈ N min » (même estimation : 15 s par découverte, 8 s par vérification, retours
  d’apprentissage compris) ; fin de séance : bilan du jour « N mots revus · N nouveaux · durée ».
- L’histoire est cochée quand toutes ses phrases ont été écoutées ; une carte « Histoire terminée ✓ »
  apparaît alors en bas avec « Étape suivante ». Un mot touché est surligné (sa bulle s’affiche au-dessus) ;
  toucher ailleurs sur la phrase la rejoue. Traduction off : un petit bouton « FR » sous chaque phrase
  montre/masque sa traduction.

## Arborescence

```
public/              servi tel quel (aucune étape de build)
  index.html  manifest.webmanifest  sw.js
  css/app.css
  js/app.js          interface (routeur par #hash, écrans)
  js/scheduler.js    planification pure : lots, file du jour, FSRS, série, semaines d’écoute
  js/text.js         découpage des phrases, traductions, mots en gras, liste des audios
  js/storage.js      localStorage + export/import
  js/audio.js        lecteur unique (HTMLAudioElement réutilisé, déblocage iOS)
  js/dates.js        dates locales
  js/guide.js        consigne de la semaine, fiches, prompts d’aide (pur)
  vendor/ts-fsrs.mjs ts-fsrs 5.4.2 (MIT, voir vendor/ts-fsrs.LICENSE)
  icons/             180, 192, 512 (+ maskable), apple-touch-icon
  data/  audio/      produits par les scripts (cards/days corrigés à la main, voir SPEC.md ;
                     weeks.json et grammar.json écrits à la main)
tests/               tests node --test + fixtures
```

## Tests

```sh
node --test tests/           # Node 22 : passe par tests/index.js
node --test tests/*.test.mjs # équivalent
```

Les tests couvrent `scheduler.js` (dont découverte et compteur de séance), `text.js` et `storage.js` (dont le rappel de sauvegarde) avec les fixtures de `tests/fixtures/data/`, ainsi que `guide.js` et la cohérence des vraies données (`guide-data.test.mjs`).

Essai local de l’interface :

```sh
python3 -m http.server 8000 --directory public   # puis http://localhost:8000/
```

## Déploiement (GitHub Pages, sous-chemin `/espagnol/`)

Toutes les URL sont relatives : il suffit de publier le contenu de `public/`.

1. Copier `public/` à la racine de la branche publiée (ou utiliser une action Pages avec `path: app/public`).
2. Dans le dépôt : *Settings › Pages* → source = la branche / l’action.
3. **À chaque mise à jour** de l’appli ou des données, incrémenter `CACHE_VERSION` dans `public/sw.js`
   (sinon les téléphones gardent l’ancienne version en cache). La nouvelle version s’active tout de suite
   (`skipWaiting` + `clients.claim`) et l’appli se recharge d’elle-même au prochain passage sur l’accueil. Si on ajoute un module JS,
   l’ajouter à la liste `SHELL` de `sw.js`.

Le cache audio (`ed-audio-v1`) est séparé et survit aux changements de version ; si un fichier audio
change de contenu sans changer de nom, renommer ce cache dans `sw.js` **et** `js/app.js`.

## Licence des dépendances

`ts-fsrs` © open-spaced-repetition, licence MIT (copie dans `public/vendor/ts-fsrs.LICENSE`).
