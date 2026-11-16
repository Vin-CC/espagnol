// Interface de « Español diario » : routeur par hash et écrans.
import * as S from './scheduler.js';
import { dayKey } from './dates.js';
import * as T from './text.js';
import * as store from './storage.js';
import * as audio from './audio.js';

const DS_URL = 'https://www.dreamingspanish.com/';
const AUDIO_CACHE = 'ed-audio-v1'; // doit correspondre à sw.js
const POS = {
  v: 'verbe', n: 'nom', adj: 'adjectif', adv: 'adverbe', prep: 'préposition', conj: 'conjonction',
  pron: 'pronom', art: 'article', num: 'nombre', interj: 'interjection', determiner: 'déterminant',
  contraction: 'contraction',
};

const app = {
  cards: null, byId: new Map(), days: [], listen: [], lexicon: null,
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
  ensureUnlocked();
  const screens = {
    aujourdhui: renderToday, mots: renderReview, histoire: renderStory,
    histoires: renderLibrary, ecoute: renderListen, reglages: renderSettings,
  };
  const fn = screens[r.name] || renderToday;
  root.replaceChildren();
  document.body.dataset.screen = r.name;
  fn(r.arg);
  renderNav(r.name);
  window.scrollTo(0, 0);
}

function leaveScreen() {
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
  const cur = active === 'histoire' ? 'histoires' : active;
  nav.replaceChildren(...items.map(([k, label, href]) =>
    h('a', { href, class: 'nav-item', 'aria-current': cur === k ? 'page' : null }, label)));
  nav.hidden = active === 'mots';
}

// ---------- Aujourd'hui ----------
function renderToday() {
  const t = now();
  const p = app.progress;
  const q = S.dailyQueue(p, t);
  const steps = S.todaySteps(p, t);
  const nRev = q.reviews.length + q.learning.length;
  const streak = S.streak(p.activity, t);

  const step = (done, num, title, sub, body, opts = {}) => h('li', { class: `step${done ? ' done' : ''}` },
    h('span', { class: 'check', 'aria-hidden': 'true' }, done ? '✓' : String(num)),
    h('div', { class: 'step-body' },
      h('h2', { class: 'step-title' }, title, opts.optional ? h('span', { class: 'tag' }, 'optionnel') : null,
        h('span', { class: 'sr-only' }, done ? ' (fait)' : ' (à faire)')),
      sub ? h('p', { class: 'step-sub' }, sub) : null,
      body));

  const storyTitle = h('span', {}, '…');
  getStory(p.day).then((s) => { storyTitle.textContent = s ? `${s.title} — ${s.title_fr}` : 'Bientôt disponible'; });

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
    h('button', { type: 'submit', class: 'btn primary' }, 'Ajouter'),
    h('button', { type: 'button', class: 'btn', onclick: () => { app.ui.ds = false; render(); } }, 'Annuler'));
    setTimeout(() => input.select(), 0);
    return form;
  };
  if (app.ui.ds) dsBody.append(dsForm());
  else {
    dsBody.append(
      h('a', { class: 'btn', href: DS_URL, target: '_blank', rel: 'noopener' }, 'Ouvrir Dreaming Spanish ↗'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { app.ui.ds = true; render(); } }, 'J’ai regardé'),
    );
  }

  let banner = null;
  if (store.needsBackupReminder(getMeta(), S.usageDays(p.activity), t)) {
    const out = h('div', { 'aria-live': 'polite' });
    const btns = h('div', { class: 'row wrapping' },
      h('button', {
        class: 'btn primary', type: 'button',
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

  root.append(
    h('header', { class: 'hero' },
      h('p', { class: 'kicker' }, 'Español diario'),
      h('h1', {}, `Jour ${p.day} / ${app.totalDays}`),
      h('ul', { class: 'stats' },
        h('li', {}, h('strong', {}, String(streak)), streak > 1 ? ' jours de suite' : ' jour de suite'),
        h('li', {}, h('strong', {}, String(S.wordsLearned(p))), ' mots appris'),
        h('li', {}, h('strong', {}, fmtHours(p.dsMinutes || 0)), ' d’écoute'))),
    banner,
    h('ol', { class: 'steps' },
      step(steps.words, 1, 'Mots',
        steps.words ? 'Terminé pour aujourd’hui' : `${plural(nRev, 'révision', 'révisions')} + ${plural(q.fresh.length, 'nouveau', 'nouveaux')}`,
        steps.words ? null : h('a', { class: 'btn primary big', href: '#/mots' }, 'Commencer')),
      step(steps.story, 2, 'Histoire du jour', storyTitle,
        h('a', { class: `btn${steps.words && !steps.story ? ' primary' : ''}`, href: `#/histoire/${p.day}` },
          steps.story ? 'Relire' : 'Lire')),
      step(steps.dreaming, 3, 'Dreaming Spanish (45 min)',
        `Cumul : ${fmtHours(p.dsMinutes || 0)}${steps.dreaming ? ` · aujourd’hui ${fmtHours(p.activity[dayKey(t)].ds)}` : ''}`,
        dsBody),
      step(steps.listen, 4, 'Écoute en trajet', 'Les mots de la semaine, à écouter sans écran.',
        h('a', { class: 'btn', href: '#/ecoute' }, 'Écouter'), { optional: true })),
  );
}

// ---------- Révision ----------
function exampleNode(card) {
  return h('p', { class: 'ex' }, T.highlightExample(card.ex_es, card)
    .map((s) => (s.hit ? h('strong', {}, s.text) : s.text)));
}

function playCard(card) {
  const urls = [card.a_word, card.a_ex].filter(Boolean).map(audioUrl);
  audio.playSequence(urls);
}

function renderReview() {
  const rv = app.review;
  const t = now();
  const id = rv.side === 'back' && rv.id != null ? rv.id : S.pickNext(app.progress, t);
  const sp = S.sessionProgress(app.progress, t);
  const lbl = S.sessionLabel(sp);
  const top = h('div', { class: 'topbar' },
    h('a', { class: 'btn ghost', href: '#/', 'aria-label': 'Quitter la révision' }, '✕ Quitter'),
    h('span', { class: 'counter' }, id == null ? '' : lbl.time));
  const pct = Math.round(sp.ratio * 100);
  const session = id == null ? null : h('div', { class: 'session' },
    h('div', {
      class: 'bar', role: 'progressbar', 'aria-label': 'Avancement de la séance',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct),
    }, h('span', { style: `width:${pct}%` })),
    h('p', { class: 'session-text', 'aria-live': 'polite' }, lbl.text));

  if (id == null) {
    root.append(top, h('section', { class: 'finish' },
      h('p', { class: 'big-check', 'aria-hidden': 'true' }, '✓'),
      h('h1', {}, 'Terminé pour aujourd’hui'),
      h('p', {}, rv.done ? `${plural(rv.done, 'carte revue', 'cartes revues')} pendant cette séance.` : 'Aucune carte à revoir pour l’instant.'),
      h('p', {}, 'Prochaine étape : l’histoire du jour.'),
      h('div', { class: 'col' },
        h('a', { class: 'btn primary big', href: `#/histoire/${app.progress.day}` }, 'Lire l’histoire du jour'),
        h('a', { class: 'btn', href: '#/' }, 'Retour à l’accueil'))));
    return;
  }
  const card = app.byId.get(id);
  if (!card) { // carte inconnue (données changées) : on la retire de la file
    const p = { ...app.progress, pending: app.progress.pending.filter((x) => x !== id), cards: { ...app.progress.cards } };
    delete p.cards[id];
    setProgress(p);
    render();
    return;
  }
  rv.id = id;
  // Carte jamais vue : découverte (recto + verso), notée « Again » pour revenir dans la séance.
  const discover = !app.progress.cards[id];
  const back = discover || rv.side === 'back';
  const showHint = discover && !getMeta().hintDiscovery;

  const flip = () => { if (!back) { rv.side = 'back'; render(); } };
  const grade = (rating) => {
    audio.stop();
    if (showHint) setMeta({ ...getMeta(), hintDiscovery: true });
    setProgress(S.rate(app.progress, id, rating, now(), app.scheduler));
    rv.side = 'front';
    rv.id = null;
    rv.done += 1;
    render();
  };

  const face = h('div', {
    class: `flash${back ? ' back' : ''}${discover ? ' discover' : ''}`,
    role: back ? null : 'button',
    tabindex: back ? null : '0',
    'aria-label': back ? null : 'Voir la réponse',
    onclick: flip,
  },
  h('p', { class: 'pos' }, POS[card.pos] || card.pos, discover ? h('span', { class: 'tag new' }, 'nouveau mot') : null),
  h('p', { class: 'lemma', lang: 'es' }, card.lemma),
  h('div', { class: 'ex-row', lang: 'es' }, exampleNode(card),
    h('button', {
      class: 'btn icon', type: 'button', 'aria-label': 'Réécouter',
      onclick: (e) => { e.stopPropagation(); playCard(card); },
    }, '🔊')),
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
    if (audio.isUnlocked()) playCard(card);
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
    onclick: () => { if (!done()) setProgress(S.markStoryDone(app.progress, day, now())); updateUi(); },
  }, 'J’ai lu l’histoire');
  const updateUi = () => {
    playBtn.textContent = noAudio ? 'Audio bientôt disponible'
      : st.playing ? '⏸ Pause' : (st.current >= 0 && st.current < story.sentences.length - 1 ? '▶ Reprendre' : '▶ Lire en écoutant');
    st.sentEls.forEach((el, i) => el.classList.toggle('current', i === st.current));
    status.textContent = done() ? '✓ Histoire lue en entier. Bravo !'
      : noAudio ? 'L’audio de cette histoire n’est pas encore prêt : lis-la, puis touche « J’ai lu l’histoire ».'
        : st.missing ? 'Certaines phrases n’ont pas pu être lues (audio indisponible).' : '';
    status.classList.toggle('muted', !done());
    manualBtn.hidden = done() || !(noAudio || st.missing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = st.playing ? 'playing' : 'paused';
  };

  const checkComplete = () => {
    if (withAudio.length && withAudio.every((i) => st.played.has(i)) && !done()) {
      setProgress(S.markStoryDone(app.progress, day, now()));
    }
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
      if (app.story !== st) return;
      if (res === 'stopped') { st.playing = false; updateUi(); return; }
      if (res === 'ended') st.played.add(k); else st.missing = true;
      if (single) break;
    }
    st.playing = false;
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
    const lines = [h('p', { class: 'b-word', lang: 'es' }, wordEl.textContent)];
    if (info.gloss) lines.push(h('p', { class: 'b-gloss' }, info.gloss));
    if (info.card && !(info.card.fr === info.gloss && T.norm(info.card.lemma) === info.word)) {
      lines.push(h('p', { class: 'b-card' }, h('span', { lang: 'es' }, info.card.lemma), ' : ', info.card.fr,
        info.card.ff ? h('span', { class: 'ff small' }, 'faux ami') : null));
    }
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
          h('p', { class: 'fr' }, s.fr)));
      st.sentEls.push(li);
      return li;
    }));
  list.addEventListener('click', (e) => {
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
      h('p', { class: 'muted' }, story.title_fr)),
    h('p', { class: 'hint' }, 'Lis en écoutant, puis une 2e fois sans traduction.'),
    h('div', { class: 'controls' }, playBtn,
      h('div', { class: 'row wrapping' },
        h('label', { class: 'switch', for: 'tr' }, trToggle, h('span', {}, 'Traduction')),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Vitesse' }, speedBtn(0.8, '0,8×'), speedBtn(1, '1×')))),
    status,
    manualBtn,
    list,
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
  root.append(h('header', { class: 'page-head' }, h('h1', {}, 'Histoires'),
    h('p', { class: 'muted' }, 'Une nouvelle histoire chaque jour, écrite avec les mots du jour.')), ul);
}

// ---------- Écoute ----------
function listenElement(w) {
  if (!app.listenEls.has(w.week)) {
    const el = h('audio', { controls: true, preload: 'none', src: audioUrl(w.file) });
    el.addEventListener('play', () => {
      audio.stop();
      for (const other of app.listenEls.values()) if (other !== el) other.pause();
      setProgress(S.markListened(app.progress, now()));
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
  const head = h('header', { class: 'page-head' }, h('h1', {}, 'Écoute en trajet'),
    h('p', { class: 'muted' }, 'Mot espagnol, pause de 3 s pour le traduire dans ta tête, traduction, puis une phrase. Fonctionne écran verrouillé.'));
  root.append(head);
  if (!app.listen.length) {
    root.append(h('p', { class: 'card' }, 'Les fichiers d’écoute ne sont pas encore disponibles.'));
    return;
  }
  const weeks = S.unlockedWeeks(app.progress.day, app.listen);
  const list = h('ul', { class: 'weeks' });
  for (const w of [...weeks].reverse()) {
    const words = (w.words || []).map((id) => app.byId.get(id)).filter(Boolean);
    list.append(h('li', { class: 'card' },
      h('h2', {}, `Semaine ${w.week}`),
      h('p', { class: 'muted', lang: 'es' }, `${words.length} mots : ${words.slice(0, 8).map((c) => c.lemma).join(', ')}${words.length > 8 ? '…' : ''}`),
      listenElement(w)));
  }
  const next = app.listen.find((w) => !weeks.includes(w));
  if (next) list.append(h('li', { class: 'card locked' }, `Semaine ${next.week} : débloquée au jour ${7 * next.week - 6}.`));
  root.append(list);
}

// ---------- Réglages ----------
function renderSettings() {
  const s = app.settings;
  const msg = (text, kind = '') => h('p', { class: `msg ${kind}`, role: 'status' }, text);

  // Nouvelles cartes par jour
  const val = h('output', { class: 'stepper-val', 'aria-live': 'polite' }, String(s.newPerDay));
  const setNew = (d) => { s.newPerDay = S.clampNew(s.newPerDay + d); val.textContent = String(s.newPerDay); persist(); };
  const newCards = h('section', { class: 'card' },
    h('h2', {}, 'Nouvelles cartes par jour'),
    h('div', { class: 'stepper' },
      h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Moins', onclick: () => setNew(-1) }, '−'), val,
      h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Plus', onclick: () => setNew(1) }, '+')),
    h('p', { class: 'muted' }, 'Entre 5 et 20 (10 conseillé). S’applique au prochain lot.'));

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
    h('p', { class: 'muted' }, 'L’appli et les textes fonctionnent déjà sans réseau. L’audio est gardé après la première écoute ; ce bouton télécharge tout d’un coup (prévoir le Wi-Fi).'),
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

  root.append(h('header', { class: 'page-head' }, h('h1', {}, 'Réglages')), newCards, cog, offline, backup, reset,
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
  app.listen = await fetchJSON('data/listen.json').catch(() => []);
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
    if (document.visibilityState === 'visible' && route().name === 'aujourdhui') render();
  });
  render();
}

init();
