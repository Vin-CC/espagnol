// Interface de « Español diario » : routeur par hash et écrans.
import * as S from './scheduler.js';
import { dayKey } from './dates.js';
import * as T from './text.js';
import * as store from './storage.js';
import * as audio from './audio.js';
import * as G from './guide.js';

const DS_URL = 'https://www.dreamingspanish.com/';
const AUDIO_CACHE = 'ed-audio-v1'; // doit correspondre à sw.js
const POS = {
  v: 'verbe', n: 'nom', adj: 'adjectif', adv: 'adverbe', prep: 'préposition', conj: 'conjonction',
  pron: 'pronom', art: 'article', num: 'nombre', interj: 'interjection', determiner: 'déterminant',
  contraction: 'contraction',
};

const app = {
  cards: null, byId: new Map(), days: [], listen: [], lexicon: null,
  weeks: [], grammar: [],  // consignes de la semaine, fiches de grammaire
  sequence: [], cogSequence: [], totalDays: 60,
  progress: S.emptyProgress(), settings: { ...S.DEFAULT_SETTINGS },
  scheduler: S.createScheduler(),
  stories: new Map(),     // jour -> Promise<histoire|null>
  review: { side: 'front', id: null, done: 0 },
  story: null,            // lecteur d'histoire en cours
  listenEls: new Map(),   // semaine -> <audio> (persistants : la lecture continue hors de l'écran)
  ui: {},                 // états éphémères (formulaires ouverts…)
};

const root = document.getElementById('app');
const dock = document.getElementById('dock');

// ---------- utilitaires DOM ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const now = () => new Date();
const audioUrl = (f) => `audio/${f}`;
const fmtHours = (min) => {
  const h0 = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h0 ? `${h0} h ${String(m).padStart(2, '0')}` : `${m} min`;
};
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function persist() {
  store.save('progress', app.progress);
  store.save('settings', app.settings);
}
function setProgress(p) { app.progress = p; persist(); }
/** Options de la file du jour (plafond de révisions réglable). */
const qopts = () => ({ maxReviews: app.settings.maxReviews });
const isStandalone = () => navigator.standalone === true
  || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);

// Temps d'audio écouté (histoires, écoute en trajet) : cumulé en mémoire, enregistré par paquets.
const heard = { story: 0, listen: 0 };
function flushHeard() {
  let p = app.progress;
  for (const k of Object.keys(heard)) {
    if (heard[k] > 0) { p = S.addListening(p, heard[k], now(), k); heard[k] = 0; }
  }
  if (p !== app.progress) setProgress(p);
}
function addHeard(kind, seconds) {
  if (!(seconds > 0) || seconds > 600) return;
  heard[kind] += seconds;
  if (heard[kind] >= 15) flushHeard();
}
// Petites informations hors progression (dernier export, aides déjà vues…), clé ed:v1:meta.
const getMeta = () => store.load('meta', {}) || {};
const setMeta = (m) => store.save('meta', m);

function ensureUnlocked() {
  const { progress, unlocked } = S.unlockIfNeeded(app.progress, {
    sequence: app.sequence, cognateSequence: app.cogSequence,
    settings: app.settings, totalDays: app.totalDays,
  }, now());
  if (unlocked) setProgress(progress);
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} : ${r.status}`);
  return r.json();
}

function getStory(day) {
  if (!app.stories.has(day)) {
    app.stories.set(day, fetchJSON(T.storyFile(day)).catch(() => {
      app.stories.delete(day); // nouvel essai plus tard (histoire peut-être publiée entre-temps)
      return null;
    }));
  }
  return app.stories.get(day);
}

// ---------- routeur ----------
function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
  return { name: parts[0] || 'aujourdhui', arg: parts[1] };
}

let lastRoute = null;
function render() {
  const r = route();
  if (lastRoute && lastRoute !== `${r.name}/${r.arg}`) leaveScreen();
  lastRoute = `${r.name}/${r.arg}`;
  if (app.updateReady && r.name === 'aujourdhui') { location.reload(); return; }
  ensureUnlocked();
  const screens = {
    aujourdhui: renderToday, mots: renderReview, histoire: renderStory,
    histoires: renderLibrary, ecoute: renderListen, reglages: renderSettings,
    fiche: renderSheet, aide: renderHelp,
  };
  const fn = screens[r.name] || renderToday;
  root.replaceChildren();
  document.body.dataset.screen = r.name;
  fn(r.arg);
  renderNav(r.name);
  window.scrollTo(0, 0);
}

function leaveScreen() {
  flushHeard();
  if (app.story) { app.story.playing = false; app.story = null; audio.stop(); }
  audio.stop();
  for (const el of app.listenEls.values()) dock.append(el); // garde la lecture en cours
  app.review = { side: 'front', id: null, done: 0 };
  app.ui = {};
}

function renderNav(active) {
  const nav = document.getElementById('nav');
  const items = [
    ['aujourdhui', 'Aujourd’hui', '#/'],
    ['histoires', 'Histoires', '#/histoires'],
    ['ecoute', 'Écoute', '#/ecoute'],
    ['reglages', 'Réglages', '#/reglages'],
  ];
  const parent = { histoire: 'histoires', fiche: 'histoires', aide: 'reglages' };
  const cur = parent[active] || active;
  nav.replaceChildren(...items.map(([k, label, href]) =>
    h('a', { href, class: 'nav-item', 'aria-current': cur === k ? 'page' : null }, label)));
  nav.hidden = active === 'mots';
}

// ---------- Aujourd'hui ----------
function renderToday() {
  flushHeard();
  const t = now();
  const today = dayKey(t);
  const p = app.progress;
  const o = qopts();
  const q = S.dailyQueue(p, t, o);
  const sp = S.sessionProgress(p, t, o);
  const steps = S.todaySteps(p, t, o);
  const act = p.activity[today] || {};
  const meta = getMeta();
  const streak = S.streak(p.activity, t);
  const best = S.bestStreak(p.activity);
  // Une seule action principale : la première étape obligatoire non faite.
  const current = ['words', 'story', 'dreaming'].find((k) => !steps[k]) || null;
  const btn = (key, extra = '') => `btn${extra}${current === key ? ' primary' : ''}`;

  const step = (done, num, title, sub, body, opts = {}) => h('li', { class: `step${done ? ' done' : ''}` },
    h('span', { class: 'check', 'aria-hidden': 'true' }, done ? '✓' : String(num)),
    h('div', { class: 'step-body' },
      h('h2', { class: 'step-title' }, title, opts.optional ? h('span', { class: 'tag' }, 'optionnel') : null,
        h('span', { class: 'sr-only' }, done ? ' (fait)' : ' (à faire)')),
      sub ? h('p', { class: 'step-sub' }, sub) : null,
      body));

  const storyTitle = h('span', {}, '…');
  getStory(p.day).then((s) => {
    const fr = s && T.frTitle(s);
    storyTitle.textContent = s ? (fr ? `${s.title} — ${fr}` : s.title) : 'Bientôt disponible';
  });

  // Mots : en mots (pas en passages de carte), même durée estimée que pendant la séance.
  const held = !steps.words && q.fresh.length === 0 && p.lastUnlock !== today && S.isBacklogHeld(p, t);
  const wordsSub = steps.words
    ? (act.rev || act.nw ? `Terminé · ${S.finishLabel(act)}` : 'Terminé pour aujourd’hui')
    : [S.wordsLabel(sp), held ? h('span', { class: 'sub-note' }, 'Les nouveaux mots attendent : on revoit d’abord.') : null];

  const dsBody = h('div', { class: 'row wrapping' });
  const dsForm = () => {
    const input = h('input', {
      type: 'number', inputmode: 'numeric', min: '1', max: '600', value: '45', id: 'ds-min', class: 'num',
    });
    const form = h('form', {
      class: 'row wrapping',
      onsubmit: (e) => {
        e.preventDefault();
        setProgress(S.logDreaming(app.progress, input.value, now()));
        app.ui.ds = false;
        render();
      },
    }, h('label', { for: 'ds-min' }, 'Minutes :'), input,
    h('button', { type: 'submit', class: btn('dreaming') }, 'Ajouter'),
    h('button', { type: 'button', class: 'btn', onclick: () => { app.ui.ds = false; render(); } }, 'Annuler'));
    setTimeout(() => input.select(), 0);
    return form;
  };
  if (app.ui.ds) dsBody.append(dsForm());
  else {
    // Avant d'avoir ouvert Dreaming Spanish, l'action principale est « Ouvrir » ; ensuite « J'ai regardé ».
    const opened = meta.dsOpened === today;
    dsBody.append(
      h('a', {
        class: opened ? 'btn' : btn('dreaming'), href: DS_URL, target: '_blank', rel: 'noopener',
        onclick: () => { setMeta({ ...getMeta(), dsOpened: today }); setTimeout(render, 400); },
      }, 'Ouvrir Dreaming Spanish ↗'),
      h('button', { class: opened ? btn('dreaming') : 'btn', type: 'button', onclick: () => { app.ui.ds = true; render(); } }, 'J’ai regardé'),
    );
  }

  let banner = null;
  if (store.needsBackupReminder(meta, S.usageDays(p.activity), t)) {
    const out = h('div', { 'aria-live': 'polite' });
    const btns = h('div', { class: 'row wrapping' },
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => exportProgress(out, () => { btns.hidden = true; }),
      }, 'Exporter'),
      h('button', {
        class: 'btn ghost', type: 'button',
        onclick: () => { setMeta(store.snoozeBackup(getMeta(), now())); banner.remove(); },
      }, 'Plus tard'));
    banner = h('section', { class: 'backup-banner', 'aria-label': 'Rappel de sauvegarde' },
      h('p', { class: 'bb-title' }, 'Sauvegarde ta progression'),
      h('p', { class: 'muted small' }, 'Elle n’est enregistrée que sur ce téléphone.'),
      btns, out);
  }

  // Installation : proposée une seule fois, après la première séance terminée.
  let install = null;
  if (meta.firstSessionDone && !meta.installDismissed && !isStandalone()) {
    install = h('section', { class: 'install-banner', 'aria-label': 'Installer l’appli' },
      h('p', {}, h('strong', {}, 'Installe l’appli : '), 'Safari › Partager › Sur l’écran d’accueil (hors-ligne + plein écran)'),
      h('button', {
        class: 'btn ghost icon', type: 'button', 'aria-label': 'Fermer',
        onclick: () => { setMeta({ ...getMeta(), installDismissed: true }); install.remove(); },
      }, '✕'));
  }

  const dayDone = current === null;
  const listenOpen = S.unlockedWeeks(p.day, app.listen, app.totalDays).length > 0;
  const welcome = !steps.words && S.daysAway(p.activity, t) >= 2
    ? h('p', { class: 'hint welcome', role: 'status' }, 'Bon retour ! On reprend en douceur.') : null;
  const streakTile = streak === 0 && best > 0
    ? h('li', {}, h('strong', { class: 'smaller' }, 'Nouvelle série'), `record : ${plural(best, 'jour', 'jours')}`)
    : h('li', {}, h('strong', {}, String(streak)), streak > 1 ? ' jours de suite' : ' jour de suite');

  root.append(...[
    dayDone ? h('section', { class: 'day-done', role: 'status' },
      h('p', { class: 'dd-title' }, 'Journée terminée ✓'),
      h('p', { class: 'small' }, 'Reviens demain pour de nouveaux mots.')) : null,
    h('header', { class: 'hero' },
      h('p', { class: 'kicker' }, 'Español diario'),
      h('h1', {}, `Jour ${p.day} / ${app.totalDays}`),
      h('ul', { class: 'stats' },
        streakTile,
        h('li', {}, h('strong', {}, String(S.wordsLearned(p))), ' mots appris'),
        h('li', {}, h('strong', {}, fmtHours(S.listeningMinutes(p))), ' d’espagnol écouté'))),
    welcome,
    install,
    banner,
    h('ol', { class: 'steps' },
      step(steps.words, 1, 'Mots', wordsSub,
        steps.words ? null : h('a', { class: btn('words', ' big'), href: '#/mots' }, act.reviews ? 'Continuer' : 'Commencer')),
      step(steps.story, 2, 'Histoire du jour', storyTitle,
        h('a', { class: btn('story'), href: `#/histoire/${p.day}` }, steps.story ? 'Relire' : 'Lire')),
      step(steps.dreaming, 3, 'Dreaming Spanish (45 min)',
        `Cumul : ${fmtHours(p.dsMinutes || 0)}${steps.dreaming ? ` · aujourd’hui ${fmtHours(act.ds)}` : ''}`,
        dsBody),
      listenOpen
        ? step(steps.listen, 4, 'Écoute en trajet', 'Les mots de la semaine, à écouter sans écran (5 min suffisent).',
          h('a', { class: 'btn', href: '#/ecoute' }, 'Écouter'), { optional: true })
        : step(false, 4, 'Écoute en trajet', `Ouvre au jour ${S.weekUnlockDay(1, app.totalDays)}, avec les mots de ta première semaine.`, null, { optional: true })),
    weekCard(p.day),
  ].filter(Boolean));
}

/** Carte discrète « Cette semaine » (pas une étape : n'empêche pas « Journée terminée »). */
function weekCard(day) {
  const tip = G.weekTip(app.weeks, day);
  if (!tip) return null;
  const sheet = tip.sheet ? app.grammar.find((s) => s.id === tip.sheet) : null;
  const link = sheet && G.isSheetUnlocked(sheet, day)
    ? h('a', { class: 'btn', href: `#/fiche/${sheet.id}` }, 'Lire la fiche')
    : tip.help ? h('a', { class: 'btn', href: '#/aide' }, 'Voir le prompt') : null;
  return h('section', { class: 'week-tip', 'aria-labelledby': 'week-tip-title' },
    h('h2', { class: 'kicker', id: 'week-tip-title' }, `Cette semaine · semaine ${G.weekOf(day)}`),
    h('p', {}, tip.text),
    link);
}

const rich = (str) => G.richSegments(str).map((x) => (x.bold ? h('strong', {}, x.text) : x.text));

// ---------- Fiche de grammaire ----------
function renderSheet(arg) {
  const day = app.progress.day;
  const sheet = app.grammar.find((s) => s.id === arg);
  const back = h('p', { class: 'center' }, h('a', { class: 'btn', href: '#/histoires' }, 'Toutes les fiches'));
  if (!sheet || !G.isSheetUnlocked(sheet, day)) {
    root.append(h('header', { class: 'page-head' }, h('h1', {}, 'Fiche'),
      h('p', { class: 'muted' }, sheet ? `Cette fiche s’ouvre au jour ${sheet.unlock}.` : 'Fiche introuvable.')), back);
    return;
  }
  const examples = h('ul', { class: 'examples' }, sheet.examples.map((e) => {
    const btn = e.audio ? h('button', {
      class: 'btn icon replay speaker', type: 'button', 'aria-label': `Écouter : ${e.es}`,
      onclick: async () => {
        btn.classList.add('playing');
        await audio.play(audioUrl(e.audio));
        btn.classList.remove('playing');
      },
    }, '▶') : null;
    return h('li', { class: btn ? null : 'no-audio' }, btn, h('div', {},
      h('p', { class: 'es', lang: 'es' }, e.es),
      h('p', { class: 'muted' }, e.fr)));
  }));
  root.append(
    h('header', { class: 'page-head' }, h('p', { class: 'kicker' }, 'Fiche · pour comprendre'), h('h1', {}, sheet.title)),
    h('section', { class: 'card sheet' }, sheet.body.map((para) => h('p', {}, rich(para)))),
    h('h2', {}, 'Dans les histoires'),
    examples,
    back);
}

// ---------- Aide (prompts pour Claude) ----------
function renderHelp() {
  const cards = G.PROMPTS.map((pr) => {
    const textId = `prompt-${pr.id}`;
    const pre = h('pre', { class: 'prompt', id: textId, tabindex: '0' }, pr.text);
    const status = h('span', { class: 'copy-status', role: 'status' });
    const copy = h('button', {
      class: 'btn', type: 'button', 'aria-describedby': textId,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(pr.text);
          status.textContent = 'Copié ✓';
        } catch {
          // Repli : sélectionne le texte pour une copie manuelle.
          const r = document.createRange();
          r.selectNodeContents(pre);
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
          status.textContent = 'Texte sélectionné : copie-le.';
        }
        setTimeout(() => { status.textContent = ''; }, 3000);
      },
    }, 'Copier');
    return h('section', { class: 'card' }, h('h2', {}, pr.title), h('p', { class: 'muted' }, pr.use), pre,
      h('div', { class: 'row' }, copy, status));
  });
  root.append(h('header', { class: 'page-head' }, h('p', { class: 'kicker' }, 'Réglages › Aide'), h('h1', {}, 'Aide'),
    h('p', { class: 'muted' }, 'Deux prompts à coller dans Claude (appli ou claude.ai).')), ...cards,
  h('p', { class: 'center' }, h('a', { class: 'btn', href: '#/reglages' }, 'Retour aux réglages')));
}

// ---------- Révision ----------
function exampleNode(card) {
  return h('p', { class: 'ex' }, T.highlightExample(card.ex_es, card)
    .map((s) => (s.hit ? h('strong', {}, s.text) : s.text)));
}

/** Joue le mot puis la phrase ; état « en lecture » sur 🔊, aide si l'audio ne part pas. */
async function playCard(card, btnEl, noteEl) {
  const urls = [card.a_word, card.a_ex].filter(Boolean).map(audioUrl);
  if (!urls.length) return;
  if (noteEl) noteEl.hidden = true;
  if (btnEl) btnEl.classList.add('playing');
  const res = await audio.playSequence(urls);
  if (btnEl) btnEl.classList.remove('playing');
  if (noteEl && (res === 'blocked' || res === 'error')) noteEl.hidden = false;
}

function renderReview() {
  const rv = app.review;
  const t = now();
  const o = qopts();
  const id = rv.side === 'back' && rv.id != null ? rv.id : S.pickNext(app.progress, t, o);
  const sp = S.sessionProgress(app.progress, t, o);

  if (id == null) {
    // Fin de séance : bilan factuel de la journée, pas de « Quitter ».
    const act = app.progress.activity[dayKey(t)] || {};
    if (act.reviews && !getMeta().firstSessionDone) setMeta({ ...getMeta(), firstSessionDone: true });
    const storyDone = S.todaySteps(app.progress, t, o).story;
    root.append(h('section', { class: 'finish' },
      h('p', { class: 'big-check', 'aria-hidden': 'true' }, '✓'),
      h('h1', {}, 'Terminé pour aujourd’hui'),
      h('p', { class: 'finish-stats' }, act.reviews ? S.finishLabel(act) : 'Aucun mot à revoir pour l’instant.'),
      sp.later ? h('p', { class: 'muted' }, 'Les autres révisions viendront les jours suivants.') : null,
      h('div', { class: 'col' },
        storyDone
          ? h('a', { class: 'btn primary big', href: '#/' }, 'Retour à l’accueil')
          : [h('a', { class: 'btn primary big', href: `#/histoire/${app.progress.day}` }, 'Lire l’histoire du jour'),
            h('a', { class: 'btn', href: '#/' }, 'Retour à l’accueil')])));
    return;
  }
  const pct = Math.round(sp.ratio * 100);
  const top = h('div', { class: 'topbar' },
    h('a', { class: 'btn ghost', href: '#/', 'aria-label': 'Quitter la révision' }, '✕ Quitter'),
    h('span', { class: 'counter', 'aria-live': 'polite' }, S.remainingLabel(sp)));
  const session = h('div', { class: 'session' },
    h('div', {
      class: 'bar', role: 'progressbar', 'aria-label': 'Avancement de la séance',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct),
    }, h('span', { style: `width:${pct}%` })));

  const card = app.byId.get(id);
  if (!card) { // carte inconnue (données changées) : on la retire de la file
    const p = { ...app.progress, pending: app.progress.pending.filter((x) => x !== id), cards: { ...app.progress.cards } };
    delete p.cards[id];
    setProgress(p);
    render();
    return;
  }
  if (rv.id !== id) rv.shownAt = Date.now();
  rv.id = id;
  // Carte jamais vue : découverte (recto + verso), notée « Again » pour revenir dans la séance.
  const discover = !app.progress.cards[id];
  const back = discover || rv.side === 'back';
  const showHint = discover && !getMeta().hintDiscovery;

  const flip = () => { if (!back) { rv.side = 'back'; render(); } };
  const grade = (rating) => {
    audio.stop();
    if (showHint) setMeta({ ...getMeta(), hintDiscovery: true });
    const spent = Math.min(90, (Date.now() - (rv.shownAt || Date.now())) / 1000);
    setProgress(S.addStudyTime(S.rate(app.progress, id, rating, now(), app.scheduler), spent, now()));
    rv.side = 'front';
    rv.id = null;
    rv.done += 1;
    render();
  };

  const audioNote = h('p', { class: 'audio-note', hidden: true }, 'Touche 🔊 pour écouter');
  const speaker = h('button', {
    class: 'btn icon speaker', type: 'button', 'aria-label': 'Écouter',
    onclick: (e) => { e.stopPropagation(); playCard(card, speaker, audioNote); },
  }, '🔊');
  const face = h('div', {
    class: `flash${back ? ' back' : ''}${discover ? ' discover' : ''}`,
    role: back ? null : 'button',
    tabindex: back ? null : '0',
    'aria-label': back ? null : 'Voir la réponse',
    onclick: flip,
  },
  h('p', { class: 'pos' }, POS[card.pos] || card.pos, discover ? h('span', { class: 'tag new' }, 'nouveau mot') : null),
  h('p', { class: 'lemma', lang: 'es' }, card.lemma),
  h('div', { class: 'ex-row', lang: 'es' }, exampleNode(card), speaker),
  audioNote,
  back ? h('div', { class: 'answer' },
    card.ff ? h('p', { class: 'ff' }, 'FAUX AMI') : null,
    h('p', { class: 'fr' }, card.fr),
    h('p', { class: 'ex-fr' }, card.ex_fr),
    card.note ? h('p', { class: 'note' }, card.note) : null,
    card.forms && card.forms.length ? h('p', { class: 'forms', lang: 'es' }, 'Formes : ', card.forms.join(', ')) : null) : null);

  const actions = discover
    ? h('div', { class: 'actions' },
      h('button', { class: 'btn primary big', type: 'button', onclick: () => grade(S.Rating.Again) }, 'Compris, suivant'))
    : back
    ? h('div', { class: 'actions two' },
      h('button', { class: 'btn again big', type: 'button', onclick: () => grade(S.Rating.Again) }, 'À revoir'),
      h('button', { class: 'btn good big', type: 'button', onclick: () => grade(S.Rating.Good) }, 'Je savais'))
    : h('div', { class: 'actions' },
      h('button', { class: 'btn primary big', type: 'button', onclick: flip }, 'Voir la réponse'));

  const hint = showHint ? h('p', { class: 'hint', role: 'note' },
    'Nouveau mot : écoute, lis, répète à voix haute. Il reviendra dans quelques minutes pour vérifier.') : null;
  root.append(top, session, h('section', { class: 'review' }, hint, face, actions));
  app.ui.keys = { flip, grade, back, discover };
  if (!back || discover) {
    face.focus({ preventScroll: true });
    if (audio.isUnlocked()) playCard(card, speaker, audioNote);
    else audioNote.hidden = false;
  }
}

// ---------- Histoire ----------
function renderStory(arg) {
  const day = Math.max(1, Math.min(app.progress.day, Number(arg) || app.progress.day));
  const sec = h('section', { class: 'story' }, h('p', { class: 'muted' }, 'Chargement…'));
  root.append(sec);
  getStory(day).then((story) => {
    if (route().name !== 'histoire' || !sec.isConnected) return;
    if (!story) {
      sec.replaceChildren(h('h1', {}, `Jour ${day}`),
        h('p', {}, 'Cette histoire n’est pas encore disponible. Réessaie plus tard.'),
        h('a', { class: 'btn', href: '#/histoires' }, 'Toutes les histoires'));
      return;
    }
    buildStory(sec, story, day);
  });
}

function buildStory(sec, story, day) {
  const st = { day, story, playing: false, current: -1, played: new Set(), sentEls: [] };
  app.story = st;
  audio.setRate(app.settings.speed);
  const done = () => !!app.progress.stories[day];

  // Audio des phrases : peut manquer (pas encore généré) ou être introuvable hors-ligne.
  const withAudio = story.sentences.map((s, i) => (s.audio ? i : -1)).filter((i) => i >= 0);
  const noAudio = withAudio.length === 0;
  const playBtn = h('button', { class: 'btn primary big', type: 'button', disabled: noAudio });
  const status = h('p', { class: 'done-note', 'aria-live': 'polite' });
  // Repli : l'étape doit pouvoir être cochée quand l'audio manque.
  const manualBtn = h('button', {
    class: 'btn', type: 'button', hidden: true,
    onclick: () => { if (!done()) finished(); },
  }, 'J’ai lu l’histoire');
  const updateUi = () => {
    playBtn.textContent = noAudio ? 'Audio bientôt disponible'
      : st.playing ? '⏸ Pause' : (st.current >= 0 && st.current < story.sentences.length - 1 ? '▶ Reprendre' : '▶ Lire en écoutant');
    st.sentEls.forEach((el, i) => el.classList.toggle('current', i === st.current));
    status.textContent = done() ? '✓ Histoire lue en entier.'
      : noAudio ? 'L’audio de cette histoire n’est pas encore prêt : lis-la, puis touche « J’ai lu l’histoire ».'
        : st.missing ? 'Certaines phrases n’ont pas pu être lues (audio indisponible).' : '';
    status.classList.toggle('muted', !done());
    manualBtn.hidden = done() || !(noAudio || st.missing);
    endCard.hidden = !done();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = st.playing ? 'playing' : 'paused';
  };

  // Fin de lecture : carte « Histoire terminée » en bas de la liste, amenée à l'écran.
  const endCard = h('section', { class: 'card story-end', hidden: true, 'aria-live': 'polite' },
    h('p', { class: 'end-title' }, 'Histoire terminée ✓'),
    h('a', { class: 'btn primary big', href: '#/' }, 'Étape suivante'));
  const finished = () => {
    setProgress(S.markStoryDone(app.progress, day, now()));
    updateUi();
    requestAnimationFrame(() => endCard.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  const checkComplete = () => {
    if (withAudio.length && withAudio.every((i) => st.played.has(i)) && !done()) finished();
  };

  const playFrom = async (i, single = false) => {
    if (app.story !== st) return;
    st.playing = true;
    setMediaSession(story, st);
    for (let k = i; k < story.sentences.length; k += 1) {
      st.current = k;
      updateUi();
      if (!story.sentences[k].audio) { st.missing = true; if (single) break; continue; }
      st.sentEls[k].scrollIntoView({ behavior: 'smooth', block: 'center' });
      const res = await audio.play(audioUrl(story.sentences[k].audio));
      if (res === 'ended') addHeard('story', (audio.element.duration || 0) / (app.settings.speed || 1));
      if (app.story !== st) return;
      if (res === 'stopped' || res === 'blocked') { st.playing = false; flushHeard(); updateUi(); return; }
      if (res === 'ended') st.played.add(k); else st.missing = true;
      if (single) break;
    }
    st.playing = false;
    flushHeard();
    checkComplete();
    if (!single && st.current === story.sentences.length - 1) st.current = -1;
    updateUi();
  };
  st.toggle = () => {
    if (noAudio) return;
    if (st.playing) { audio.stop(); st.playing = false; updateUi(); return; }
    playFrom(st.current >= 0 ? st.current : 0);
  };
  st.next = () => playFrom(Math.min(story.sentences.length - 1, st.current + 1));
  st.prev = () => playFrom(Math.max(0, st.current - 1));
  playBtn.addEventListener('click', st.toggle);

  // Bulle de traduction
  const bubble = h('div', { class: 'bubble', role: 'dialog', 'aria-live': 'polite', hidden: true });
  let activeWord = null;
  const closeBubble = () => {
    bubble.hidden = true;
    if (activeWord) { activeWord.classList.remove('active'); activeWord = null; }
  };
  const showBubble = (wordEl) => {
    closeBubble();
    activeWord = wordEl;
    wordEl.classList.add('active');
    const info = T.lookupWord(wordEl.textContent, story.gloss, app.lexicon);
    const b = T.bubbleInfo(info);
    const lines = [h('p', { class: 'b-word', lang: 'es' }, wordEl.textContent)];
    if (b.gloss) lines.push(h('p', { class: 'b-gloss' }, b.gloss));
    if (b.lemma || b.cardFr) {
      lines.push(h('p', { class: 'b-card' },
        b.lemma && !b.cardFr ? 'forme de ' : null,
        b.lemma ? h('span', { lang: 'es' }, b.lemma) : null, b.lemma && b.cardFr ? ' : ' : null,
        b.cardFr, b.ff ? h('span', { class: 'ff small' }, 'faux ami') : null));
    } else if (b.ff) lines.push(h('p', {}, h('span', { class: 'ff small' }, 'faux ami')));
    if (!info.gloss && !info.card) lines.push(h('p', { class: 'muted' }, 'Pas de traduction pour ce mot.'));
    bubble.replaceChildren(...lines);
    bubble.hidden = false;
    const r = wordEl.getBoundingClientRect();
    const host = sec.getBoundingClientRect();
    // Au-dessus du mot pour ne pas cacher la ligne suivante ; dessous s'il n'y a pas la place
    // (sous la barre de lecture collante).
    const controls = sec.querySelector('.controls');
    const minTop = controls ? controls.getBoundingClientRect().bottom : 0;
    const bh = bubble.offsetHeight;
    const above = r.top - bh - 6 >= minTop;
    bubble.style.top = `${(above ? r.top - bh - 6 : r.bottom + 6) - host.top}px`;
    const left = Math.max(8, Math.min(r.left - host.left, host.width - Math.min(280, host.width - 16) - 8));
    bubble.style.left = `${left}px`;
  };

  const showFr = () => app.settings.showTranslation;
  const list = h('ol', { class: `sentences${showFr() ? ' with-fr' : ''}` },
    story.sentences.map((s, i) => {
      const li = h('li', { class: 'sent', 'data-i': String(i) },
        s.audio ? h('button', { class: 'btn icon replay', type: 'button', 'aria-label': `Rejouer la phrase ${i + 1}` }, '▶') : null,
        h('div', {},
          h('p', { class: 'es', lang: 'es' }, T.tokenize(s.es).map((tk) => (tk.word ? h('span', { class: 'w' }, tk.text) : tk.text))),
          h('p', { class: 'fr', id: `fr-${i}` }, s.fr),
          s.fr ? h('button', {
            class: 'fr-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': `fr-${i}`,
            'aria-label': `Traduction de la phrase ${i + 1}`,
          }, h('span', {}, 'FR')) : null));
      st.sentEls.push(li);
      return li;
    }));
  list.addEventListener('click', (e) => {
    const fb = e.target.closest('.fr-btn');
    if (fb) { // traduction de cette phrase seulement (tap à nouveau = masquer)
      e.stopPropagation();
      const open = fb.closest('.sent').classList.toggle('show-fr');
      fb.setAttribute('aria-expanded', String(open));
      return;
    }
    const w = e.target.closest('.w');
    if (w) { e.stopPropagation(); showBubble(w); return; }
    const li = e.target.closest('.sent');
    if (li && !noAudio) { closeBubble(); playFrom(Number(li.dataset.i), true); }
  });
  sec.addEventListener('click', (e) => { if (!e.target.closest('.w') && !e.target.closest('.bubble')) closeBubble(); });

  const trToggle = h('input', {
    type: 'checkbox', role: 'switch', id: 'tr', checked: showFr(),
    onchange: (e) => {
      app.settings.showTranslation = e.target.checked; persist();
      list.classList.toggle('with-fr', e.target.checked);
    },
  });
  const speedBtn = (v, label) => h('button', {
    type: 'button', class: 'seg', 'aria-pressed': String(app.settings.speed === v),
    onclick: (e) => {
      app.settings.speed = v; persist(); audio.setRate(v);
      e.target.parentElement.querySelectorAll('.seg').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target)));
    },
  }, label);

  sec.replaceChildren(
    h('header', { class: 'story-head' },
      h('p', { class: 'kicker' }, `Histoire · jour ${day}`),
      h('h1', { lang: 'es' }, story.title),
      T.frTitle(story) ? h('p', { class: 'muted' }, T.frTitle(story)) : null),
    h('p', { class: 'hint' }, 'Écoute en lisant. Touche un mot pour le traduire, touche ‹ FR › sous une phrase pour voir sa traduction.'),
    h('div', { class: 'controls' }, playBtn,
      h('div', { class: 'row wrapping' },
        h('label', { class: 'switch', for: 'tr' }, trToggle, h('span', {}, 'Traduction')),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Vitesse' }, speedBtn(0.8, '0,8×'), speedBtn(1, '1×')))),
    status,
    manualBtn,
    list,
    endCard,
    bubble,
    h('p', { class: 'center' }, h('a', { class: 'btn', href: '#/histoires' }, 'Toutes les histoires')),
  );
  updateUi();
}

function setMediaSession(story, st) {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    ms.metadata = new MediaMetadata({
      title: story.title, artist: 'Español diario', album: `Histoire du jour ${st.day}`,
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    ms.setActionHandler('play', () => { if (!st.playing) st.toggle(); });
    ms.setActionHandler('pause', () => { if (st.playing) st.toggle(); });
    ms.setActionHandler('nexttrack', () => st.next());
    ms.setActionHandler('previoustrack', () => st.prev());
  } catch { /* action non prise en charge */ }
}

// ---------- Bibliothèque ----------
function renderLibrary() {
  const ul = h('ul', { class: 'library' });
  for (let d = app.progress.day; d >= 1; d -= 1) {
    const title = h('span', { class: 'lib-title' }, '…');
    const read = !!app.progress.stories[d];
    ul.append(h('li', {}, h('a', { href: `#/histoire/${d}`, class: 'lib-item' },
      h('span', { class: 'lib-day' }, `Jour ${d}`), title,
      h('span', { class: 'lib-check', 'aria-label': read ? 'lue' : 'non lue' }, read ? '✓' : ''))));
    getStory(d).then((s) => { title.textContent = s ? s.title : 'bientôt disponible'; });
  }
  const { unlocked, next } = G.sheetsFor(app.grammar, app.progress.day);
  const sheets = app.grammar.length ? h('section', { class: 'sheets', 'aria-labelledby': 'sheets-title' },
    h('h2', { id: 'sheets-title' }, 'Fiches de grammaire'),
    h('ul', { class: 'library' }, unlocked.map((s) => h('li', {}, h('a', { href: `#/fiche/${s.id}`, class: 'lib-item' },
      h('span', { class: 'lib-title' }, s.title))))),
    next ? h('p', { class: 'muted small' }, `Prochaine fiche au jour ${next.unlock} : ${next.title}.`) : null) : null;
  root.append(h('header', { class: 'page-head' }, h('h1', {}, 'Histoires'),
    h('p', { class: 'muted' }, 'Une nouvelle histoire chaque jour, écrite avec les mots du jour.')), sheets,
  sheets ? h('h2', {}, 'Histoires') : null, ul);
}

// ---------- Écoute ----------
const fmtDuration = (sec) => `${Math.max(1, Math.round(sec / 60))} min`;
const weekDays = (w) => S.weekDayRange(w.week, app.totalDays);

function listenElement(w) {
  if (!app.listenEls.has(w.week)) {
    const el = h('audio', { controls: true, preload: 'metadata', src: audioUrl(w.file) });
    // Temps réellement écouté (timeupdate) : l'étape est cochée après 5 min cumulées.
    let last = null;
    const resync = () => { last = el.currentTime; };
    el.addEventListener('playing', resync);
    el.addEventListener('seeked', resync);
    el.addEventListener('timeupdate', () => {
      if (el.paused || last == null) return;
      const d = el.currentTime - last;
      last = el.currentTime;
      if (d > 0 && d < 3) addHeard('listen', d / (el.playbackRate || 1));
    });
    const stop = () => { last = null; flushHeard(); };
    el.addEventListener('pause', stop);
    el.addEventListener('ended', stop);
    el.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(el.duration)) return;
      const m = getMeta();
      const durations = { ...(m.listenDur || {}), [w.week]: Math.round(el.duration) };
      if (m.listenDur?.[w.week] !== durations[w.week]) setMeta({ ...m, listenDur: durations });
      const out = document.getElementById(`dur-${w.week}`);
      if (out) out.textContent = ` · ${fmtDuration(el.duration)}`;
    });
    el.addEventListener('play', () => {
      audio.stop();
      for (const other of app.listenEls.values()) if (other !== el) other.pause();
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: `Semaine ${w.week}`, artist: 'Español diario', album: 'Écoute en trajet',
            artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
          });
          navigator.mediaSession.setActionHandler('play', () => el.play());
          navigator.mediaSession.setActionHandler('pause', () => el.pause());
          navigator.mediaSession.setActionHandler('seekbackward', () => { el.currentTime = Math.max(0, el.currentTime - 10); });
          navigator.mediaSession.setActionHandler('seekforward', () => { el.currentTime += 10; });
          navigator.mediaSession.setActionHandler('nexttrack', null);
          navigator.mediaSession.setActionHandler('previoustrack', null);
        } catch { /* ignoré */ }
      }
    });
    app.listenEls.set(w.week, el);
  }
  return app.listenEls.get(w.week);
}

function renderListen() {
  const done = S.todaySteps(app.progress, now(), qopts()).listen;
  const head = h('header', { class: 'page-head' }, h('h1', {}, 'Écoute en trajet'),
    h('p', { class: 'muted' }, 'Mot espagnol, pause de 3 s pour le traduire dans ta tête, traduction, puis une phrase. Fonctionne écran verrouillé.'),
    h('p', { class: done ? 'done-note' : 'muted small' }, done ? '✓ Écoute du jour faite.' : 'L’étape du jour est cochée après 5 min d’écoute.'));
  root.append(head);
  if (!app.listen.length) {
    root.append(h('p', { class: 'card' }, 'Les fichiers d’écoute ne sont pas encore disponibles.'));
    return;
  }
  const weeks = S.unlockedWeeks(app.progress.day, app.listen, app.totalDays);
  const known = getMeta().listenDur || {};
  const list = h('ul', { class: 'weeks' });
  for (const w of [...weeks].reverse()) {
    const words = (w.words || []).map((id) => app.byId.get(id)).filter(Boolean);
    const [a, b] = weekDays(w);
    const el = listenElement(w);
    const dur = Number.isFinite(el.duration) ? el.duration : known[w.week];
    list.append(h('li', { class: 'card' },
      h('h2', {}, `Semaine ${w.week}`),
      h('p', { class: 'week-meta' }, `Révise les mots des jours ${a} à ${b}`, h('span', { id: `dur-${w.week}` }, dur ? ` · ${fmtDuration(dur)}` : '')),
      h('p', { class: 'muted small', lang: 'es' }, `${words.slice(0, 8).map((c) => c.lemma).join(', ')}${words.length > 8 ? '…' : ''}`),
      el));
  }
  const next = app.listen.find((w) => !weeks.includes(w));
  if (next) {
    list.append(h('li', { class: 'card locked' },
      `Semaine ${next.week} : s’ouvre au jour ${S.weekUnlockDay(next.week, app.totalDays)}, avec les mots des jours ${S.weekDayRange(next.week, app.totalDays).join(' à ')}.`));
  }
  root.append(list);
}

// ---------- Réglages ----------
function renderSettings() {
  const s = app.settings;
  const msg = (text, kind = '') => h('p', { class: `msg ${kind}`, role: 'status' }, text);

  // Aide : prompts pour écrire et parler avec Claude
  const help = h('section', { class: 'card' },
    h('h2', {}, 'Aide'),
    h('p', { class: 'muted' }, 'Prompts à copier pour faire corriger tes phrases et parler avec Claude.'),
    h('a', { class: 'btn', href: '#/aide' }, 'Ouvrir l’aide'));

  // Plafond de révisions par jour (après une absence, le reste est reporté)
  const revVal = h('output', { class: 'stepper-val', 'aria-live': 'polite' }, String(s.maxReviews));
  const setRev = (d) => { s.maxReviews = S.clampReviews(s.maxReviews + d); revVal.textContent = String(s.maxReviews); persist(); };
  const maxRev = h('section', { class: 'card' },
    h('h2', {}, 'Révisions max par jour'),
    h('div', { class: 'stepper' },
      h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Moins de révisions', onclick: () => setRev(-10) }, '−'), revVal,
      h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Plus de révisions', onclick: () => setRev(10) }, '+')),
    h('p', { class: 'muted' }, `Entre ${S.MIN_REVIEWS} et ${S.MAX_REVIEWS} (60 conseillé, ≈ 8 min). Après une absence, le reste est gardé pour les jours suivants.`));

  const cog = h('section', { class: 'card' },
    h('label', { class: 'switch', for: 'cog' },
      h('input', {
        type: 'checkbox', role: 'switch', id: 'cog', checked: s.cognates,
        onchange: (e) => { s.cognates = e.target.checked; persist(); },
      }),
      h('span', {}, 'Inclure les cognats transparents')),
    h('p', { class: 'muted' }, '5 mots de plus par jour, faciles car proches du français (ex. : « hospital »).'));

  // Hors-ligne
  const dlStatus = h('div', { 'aria-live': 'polite' });
  const dlBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => downloadAll(dlBtn, dlStatus) },
    'Télécharger tout l’audio pour le hors-ligne');
  const offline = h('section', { class: 'card' }, h('h2', {}, 'Hors-ligne'),
    h('p', { class: 'muted' }, 'L’appli et les textes fonctionnent déjà sans réseau. L’audio est gardé après la première écoute ; ce bouton télécharge tout d’un coup : environ 125 Mo, en Wi-Fi.'),
    dlBtn, dlStatus);

  // Sauvegarde
  const out = h('div', {});
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', id: 'imp-file', class: 'sr-only' });
  const area = h('textarea', { id: 'imp-text', rows: '4', placeholder: 'Ou colle ici le contenu d’une sauvegarde…' });
  const doImport = (text) => {
    const r = store.parseImport(text);
    if (!r.ok) { out.replaceChildren(msg(r.error, 'err')); return; }
    store.restore(r.data);
    loadState();
    // Redessine l'écran : le compteur et les interrupteurs doivent refléter les réglages importés.
    app.ui.importMsg = 'Progression importée.';
    render();
  };
  if (app.ui.importMsg) {
    const m = msg(app.ui.importMsg, 'ok');
    out.append(m); app.ui.importMsg = null;
    requestAnimationFrame(() => m.scrollIntoView({ block: 'center' }));
  }
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    if (f) doImport(await f.text());
    fileIn.value = '';
  });
  const backup = h('section', { class: 'card' }, h('h2', {}, 'Sauvegarde'),
    h('p', { class: 'muted' }, 'La progression est enregistrée sur ce téléphone uniquement. Exporte-la de temps en temps.'),
    h('div', { class: 'col' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => exportProgress(out) }, 'Exporter ma progression'),
      h('label', { class: 'btn', for: 'imp-file' }, 'Importer un fichier…'), fileIn,
      h('label', { for: 'imp-text', class: 'sr-only' }, 'Sauvegarde à coller'), area,
      h('button', { class: 'btn', type: 'button', onclick: () => doImport(area.value) }, 'Importer le texte collé')),
    out);

  // Remise à zéro (confirmation intégrée)
  const reset = h('section', { class: 'card danger-zone' }, h('h2', {}, 'Remise à zéro'));
  const drawReset = () => {
    const kids = [h('h2', {}, 'Remise à zéro')];
    if (!app.ui.confirmReset) {
      kids.push(h('button', { class: 'btn danger', type: 'button', onclick: () => { app.ui.confirmReset = true; drawReset(); } }, 'Tout remettre à zéro'));
    } else {
      kids.push(h('p', { role: 'alert' }, 'Toute la progression sera effacée (cartes, histoires, heures). Continuer ?'),
        h('div', { class: 'row wrapping' },
          h('button', { class: 'btn', type: 'button', onclick: () => { app.ui.confirmReset = false; drawReset(); } }, 'Annuler'),
          h('button', {
            class: 'btn danger', type: 'button',
            onclick: () => { store.clearAll(); loadState(); location.hash = '#/'; render(); },
          }, 'Oui, tout effacer')));
    }
    reset.replaceChildren(...kids);
  };
  drawReset();

  root.append(h('header', { class: 'page-head' }, h('h1', {}, 'Réglages')), help, maxRev, cog, offline, backup, reset,
    h('p', { class: 'muted center small' }, 'Español diario · FSRS (ts-fsrs, MIT)'));
}

/** Exporte la progression ; `onDone` est appelé quand la sauvegarde a bien été transmise. */
async function exportProgress(out, onDone = () => {}) {
  const exported = () => { setMeta(store.markExported(getMeta(), now())); onDone(); };
  const payload = store.buildExport(store.snapshot());
  const json = JSON.stringify(payload, null, 1);
  const name = `espanol-diario-${dayKey(now())}.json`;
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Sauvegarde Español diario' });
      out.replaceChildren(h('p', { class: 'msg ok' }, 'Sauvegarde partagée.'));
      exported();
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  if (!isIOS) {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    exported();
  }
  const ta = h('textarea', { rows: '6', readonly: true, 'aria-label': 'Sauvegarde au format JSON' });
  ta.value = json;
  out.replaceChildren(
    h('p', { class: 'msg ok' }, isIOS ? 'Copie ce texte et garde-le (Notes, mail…) :' : 'Fichier téléchargé. Le contenu est aussi ci-dessous :'),
    ta,
    h('button', {
      class: 'btn', type: 'button',
      onclick: async (e) => {
        try {
          await navigator.clipboard.writeText(json);
          e.target.textContent = 'Copié ✓';
          if (isIOS) exported();
        } catch { ta.select(); }
      },
    }, 'Copier'));
}

async function downloadAll(btn, status) {
  if (!('caches' in window)) { status.replaceChildren(h('p', { class: 'msg err' }, 'Ce navigateur ne permet pas le stockage hors-ligne.')); return; }
  btn.disabled = true;
  const bar = h('progress', { max: '1', value: '0' });
  const label = h('p', { class: 'muted' }, 'Préparation…');
  status.replaceChildren(bar, label);
  const stories = await Promise.all(Array.from({ length: app.totalDays }, (_, i) => getStory(i + 1)));
  const files = T.collectAudio(app.cards, stories.filter(Boolean), app.listen);
  const cache = await caches.open(AUDIO_CACHE);
  let done = 0; let failed = 0;
  bar.max = files.length;
  const queue = [...files];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const url = new URL(audioUrl(f), location.href).href;
      try {
        if (!(await cache.match(url))) {
          const r = await fetch(url, { cache: 'no-store' });
          if (r.ok && r.status === 200) await cache.put(url, r); else failed += 1;
        }
      } catch { failed += 1; }
      done += 1;
      bar.value = done;
      label.textContent = `${done} / ${files.length} fichiers`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  label.textContent = failed ? `Terminé : ${files.length - failed} fichiers disponibles hors-ligne, ${failed} introuvables (réessaie plus tard).`
    : `Terminé : les ${files.length} fichiers audio sont disponibles hors-ligne.`;
  btn.disabled = false;
}

// ---------- démarrage ----------
function loadState() {
  app.progress = S.normalizeProgress(store.load('progress'));
  app.settings = S.normalizeSettings(store.load('settings'));
}

function onKey(e) {
  if (route().name !== 'mots' || !app.ui.keys || e.target.closest('input,textarea')) return;
  const k = app.ui.keys;
  if (k.discover) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); k.grade(S.Rating.Again); }
    return;
  }
  if (!k.back && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); k.flip(); }
  else if (k.back && e.key === '1') k.grade(S.Rating.Again);
  else if (k.back && (e.key === '2' || e.key === ' ')) { e.preventDefault(); k.grade(S.Rating.Good); }
}

async function init() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // Nouvelle version activée (skipWaiting + clients.claim) : on recharge, mais seulement sur
    // l'accueil pour ne jamais interrompre une séance ou une lecture.
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        app.updateReady = true;
        if (route().name === 'aujourdhui' && !app.ui.ds) location.reload();
      });
    }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  try {
    const [cards, days] = await Promise.all([fetchJSON('data/cards.json'), fetchJSON('data/days.json')]);
    app.cards = cards;
    app.days = days;
  } catch {
    root.replaceChildren(h('section', { class: 'card' }, h('h1', {}, 'Oups'),
      h('p', {}, 'Impossible de charger les données. Vérifie ta connexion puis rouvre l’appli.')));
    return;
  }
  [app.listen, app.weeks, app.grammar] = await Promise.all(['listen', 'weeks', 'grammar']
    .map((f) => fetchJSON(`data/${f}.json`).catch(() => [])));
  for (const deck of Object.values(app.cards)) for (const c of deck) app.byId.set(c.id, c);
  app.lexicon = T.buildLexicon(app.cards);
  app.sequence = S.buildSequence(app.cards, app.days);
  app.cogSequence = S.buildCognateSequence(app.cards);
  app.totalDays = app.days.length || 60;
  loadState();

  // Premier geste de la session : débloque l'audio (iOS).
  const unlock = () => audio.unlock();
  document.addEventListener('touchend', unlock, { capture: true, passive: true });
  document.addEventListener('click', unlock, { capture: true });
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushHeard();
    if (document.visibilityState === 'visible' && route().name === 'aujourdhui') render();
  });
  render();
}

init();
