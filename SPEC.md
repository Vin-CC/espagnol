# « Español diario » — cahier des charges de la web app (PWA)

Utilisateur : francophone débutant complet, iPhone, appli ajoutée à l'écran d'accueil depuis Safari.
Objectif produit : **un seul parcours quotidien simple**, qui combine vocabulaire de haute fréquence (révision espacée FSRS)
et input compréhensible (histoire du jour écrite avec les mots du jour, lue en écoutant l'audio).
**La facilité d'usage prime** : zéro réglage obligatoire, gros boutons, une action évidente par écran. Interface en français.

## Contraintes techniques
- Statique, **sans étape de build** : `public/` est servi tel quel (GitHub Pages, sous-chemin `/espagnol/` → **URLs relatives partout**).
- JS moderne en modules ES natifs, CSS maison. Pas de framework lourd. `ts-fsrs` (MIT) **vendoré** dans `public/vendor/` (copier le build ESM depuis npm : `npm pack ts-fsrs` ou `node_modules/ts-fsrs/dist/index.mjs`), pas de CDN au runtime.
- Hors ligne : `sw.js` (service worker) met en cache l'app shell + `data/*.json` à l'installation ; audio mis en cache à la première lecture ; bouton « Télécharger tout l'audio pour le hors-ligne » (progression affichée) dans Réglages. Versionner le cache (constante `CACHE_VERSION`).
- Stockage : `localStorage` (clé `ed:v1:*`), JSON. Appeler `navigator.storage.persist()`. Réglages > « Exporter ma progression » (télécharge un .json — sur iOS, utiliser `navigator.share` avec un File si dispo, sinon afficher le JSON à copier) et « Importer ».
- iOS : `manifest.webmanifest` (display standalone, start_url `./`, icônes 180/192/512 PNG + apple-touch-icon), `viewport-fit=cover`, safe-area insets, thème clair/sombre (`prefers-color-scheme`). L'audio ne démarre qu'après un geste : un seul `HTMLAudioElement` réutilisé, lecture déclenchée par un tap. Media Session API (titre, play/pause) pour le mode écoute.

## Données (contrat — produites par des scripts, ne pas les modifier)
- `data/cards.json` : `{ main: Card[876], cognates: Card[550], function_words: Card[74] }`,
  `Card = { id, lemma, pos, fr, ex_es, ex_fr, note, ff (faux ami bool), forms: string[], a_word, a_ex }` ; `a_*` = nom de fichier dans `audio/`.
- `data/days.json` : `[{ day: 1..60, new: [id × 10] }]` — l'ordre des nouvelles cartes du paquet principal.
- `data/stories/day-NN.json` (NN = 01..60) : `{ day, title, title_fr, sentences: [{ es, fr, audio }], gloss: { "forme_en_minuscules": "traduction en contexte" } }`.
  Les histoires arrivent en parallèle de ton travail : **pour développer, crée tes propres fixtures dans `tests/fixtures/`**, n'écris jamais dans `public/data/` ni `public/audio/`.
- `data/listen.json` : `[{ week: 1..9, file: "listen-w01.mp3", words: [ids] }]` ; fichiers MP3 longs (mot ES, pause 3 s, traduction FR, phrase ES).
- `audio/*.mp3` : tous les fichiers audio.

## Écrans
1. **Aujourd'hui** (écran d'accueil) : « Jour N / 60 », puis 4 étapes en cartes cochables, dans l'ordre :
   1. **Mots** — « X révisions + 10 nouveaux » → ouvre la révision. Coché automatiquement quand la file du jour est vide.
   2. **Histoire du jour** — titre ; coché après une lecture complète avec audio.
   3. **Dreaming Spanish (45 min)** — lien `https://www.dreamingspanish.com/` (nouvel onglet) + bouton « J'ai regardé » qui demande les minutes (préremplies 45) ; cumul d'heures affiché.
   4. **Écoute en trajet** (optionnel) — ouvre le mode écoute.
   Bandeau : série de jours consécutifs, mots appris, heures d'écoute cumulées.
2. **Révision** : file = cartes dues (révisions d'abord) + nouvelles cartes du jour (10 par défaut, réglable 5–20).
   Une journée de nouvelles cartes = le lot `days[N]` suivant ; on ne débloque **qu'un lot par jour calendaire** ; le jour N courant = nombre de lots débloqués.
   - Recto : nature (petit), **mot** (très grand), phrase exemple ES avec le mot en gras ; lecture auto de l'audio du mot puis de la phrase (si l'audio a été « débloqué » par un geste dans la session) ; bouton 🔊 pour réécouter.
   - Tap n'importe où / bouton « Voir la réponse » → verso : traduction FR (grand), phrase FR, note, badge « FAUX AMI » rouge si `ff`, formes.
   - Deux boutons seulement : **« À revoir »** (FSRS Rating.Again) et **« Je savais »** (Rating.Good). Les cartes en apprentissage dues dans la session reviennent dans la file (ts-fsrs `enable_short_term: true`, `request_retention: 0.9`).
   - Compteur restant, et fin de séance claire (« Terminé pour aujourd'hui »).
   - Option Réglages : inclure les cognats transparents (5 nouveaux/jour, désactivé par défaut).
3. **Histoire** : liste des phrases ; bouton **« Lire en écoutant »** : joue l'audio phrase par phrase et **surligne la phrase en cours** (défilement auto) ; tap sur une phrase = la rejouer ; **tap sur un mot** = bulle avec la traduction (`gloss[mot]`, et si le mot est un lemme/forme du paquet : la traduction de la carte) ; interrupteur « Traduction » (affiche le FR sous chaque phrase, désactivé par défaut) ; vitesse 0,8× / 1×. Consigne affichée : « Lis en écoutant, puis une 2e fois sans traduction. » Bibliothèque des histoires débloquées (jours ≤ N).
4. **Écoute** : semaines débloquées (semaine W si lots ≥ 7W−6 débloqués), un lecteur `<audio>` natif par semaine (fonctionne écran verrouillé), Media Session.
5. **Réglages** : nouvelles cartes/jour, cognats, téléchargement hors-ligne, export/import, remise à zéro (avec confirmation intégrée à la page — pas de `confirm()`).

## Qualité
- Accessible (boutons ≥ 44 px, focus visible), rapide (données chargées une fois), aucune erreur console.
- `tests/` : tests unitaires `node --test` du module de planification (déblocage d'un lot par jour, file du jour, transitions FSRS, calcul de série) — la logique doit être dans des modules purs importables par Node.
- `README.md` : installation sur iPhone (Safari → Partager → « Sur l'écran d'accueil »), sauvegarde, déploiement.
