// Logique de planification : déblocage des lots, file du jour, FSRS, série.
// Module pur (aucun accès au DOM ni au stockage) : importable par Node pour les tests.
// Les fonctions qui modifient la progression renvoient une NOUVELLE progression.

import { createEmptyCard, fsrs, generatorParameters, Rating, State } from '../vendor/ts-fsrs.mjs';
import { dayKey, endOfDay, addDays, fromDayKey } from './dates.js';

export { Rating, State };

export const DEFAULT_SETTINGS = Object.freeze({
  newPerDay: 10,        // 5–20
  cognates: false,      // cognats transparents : 5 nouveaux/jour
  speed: 1,             // vitesse de lecture des histoires (0.8 ou 1)
  showTranslation: false,
  maxReviews: 60,       // révisions max par jour (30–150) : évite le mur de cartes après une absence
});
export const COGNATES_PER_DAY = 5;
export const MIN_NEW = 5;
export const MAX_NEW = 20;
export const MIN_REVIEWS = 30;
export const MAX_REVIEWS = 150;
/** Au-delà de ce nombre de révisions dues, on ne débloque pas de nouveau lot (il attend le lendemain). */
export const BACKLOG_HOLD = 40;
/** Écoute en trajet : l'étape est cochée après 5 min d'écoute cumulée dans la journée. */
export const LISTEN_DONE_SECONDS = 300;

const FSRS_PARAMS = generatorParameters({ enable_short_term: true, request_retention: 0.9 });
/** Nombre d'étapes d'(ré)apprentissage court terme (ts-fsrs : 1 min, 10 min / 10 min). */
export const LEARNING_STEPS = FSRS_PARAMS.learning_steps.length;
export const RELEARNING_STEPS = FSRS_PARAMS.relearning_steps.length;

/** Instance FSRS partagée : apprentissage court terme, rétention 0,9. */
export function createScheduler() {
  return fsrs(FSRS_PARAMS);
}

export function emptyProgress() {
  return {
    v: 1,
    day: 0,               // nombre de lots débloqués = « Jour N »
    lastUnlock: null,     // clé du dernier jour où un lot a été débloqué
    cursor: 0,            // position dans la séquence principale
    cogCursor: 0,         // position dans la séquence des cognats
    pending: [],          // nouvelles cartes attribuées, pas encore vues
    lot: [],              // nouvelles cartes du dernier lot débloqué (vues ou non)
    cards: {},            // id -> état FSRS sérialisé (dates ISO)
    activity: {},         // 'AAAA-MM-JJ' -> { reviews, story, ds, listen }
    stories: {},          // jour d'histoire -> clé du jour où elle a été lue en entier
    dsMinutes: 0,         // minutes Dreaming Spanish cumulées
    audioSec: 0,          // secondes d'audio écoutées (histoires + écoute en trajet)
  };
}

/** Normalise une progression lue depuis le stockage (champs manquants). */
export function normalizeProgress(p) {
  const base = emptyProgress();
  if (!p || typeof p !== 'object') return base;
  const pending = Array.isArray(p.pending) ? p.pending : [];
  // Anciennes progressions sans `lot` : le lot en cours est approximé par les cartes en attente.
  return { ...base, ...p, pending, lot: Array.isArray(p.lot) ? p.lot : [...pending] };
}

export function normalizeSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  out.newPerDay = clampNew(out.newPerDay);
  out.cognates = !!out.cognates;
  out.speed = out.speed === 0.8 ? 0.8 : 1;
  out.showTranslation = !!out.showTranslation;
  out.maxReviews = clampReviews(out.maxReviews);
  return out;
}

export function clampReviews(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.maxReviews;
  return Math.min(MAX_REVIEWS, Math.max(MIN_REVIEWS, v));
}

export function clampNew(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.newPerDay;
  return Math.min(MAX_NEW, Math.max(MIN_NEW, v));
}

/**
 * Ordre d'introduction du paquet principal : les lots de days.json dans l'ordre,
 * puis les cartes principales restantes dans l'ordre du fichier.
 */
export function buildSequence(cardsData, days) {
  const seen = new Set();
  const seq = [];
  for (const d of [...days].sort((a, b) => a.day - b.day)) {
    for (const id of d.new) if (!seen.has(id)) { seen.add(id); seq.push(id); }
  }
  for (const c of cardsData.main) if (!seen.has(c.id)) { seen.add(c.id); seq.push(c.id); }
  return seq;
}

export function buildCognateSequence(cardsData) {
  return (cardsData.cognates || []).map((c) => c.id);
}

function clone(p) {
  return {
    ...p,
    pending: [...p.pending],
    lot: [...(p.lot || [])],
    cards: { ...p.cards },
    activity: { ...p.activity },
    stories: { ...p.stories },
  };
}

/**
 * Débloque au plus un lot par jour calendaire.
 * Un nouveau lot n'est débloqué que si les nouvelles cartes du lot précédent ont toutes été vues
 * (un jour sauté ne crée pas d'arriéré). Le lot = les `newPerDay` cartes suivantes de la séquence
 * (+ 5 cognats si l'option est active). `day` est plafonné à `totalDays` (60).
 * Après une absence (plus de BACKLOG_HOLD révisions dues ce jour-là), le lot attend : `day` n'avance
 * pas, aucun jour n'est « perdu ».
 * @returns {{progress: object, unlocked: boolean}}
 */
export function unlockIfNeeded(progress, ctx, now) {
  const { sequence, cognateSequence = [], settings = DEFAULT_SETTINGS, totalDays = 60 } = ctx;
  const today = dayKey(now);
  if (progress.lastUnlock === today) return { progress, unlocked: false };
  if (progress.pending.some((id) => !progress.cards[id])) return { progress, unlocked: false };
  if (isBacklogHeld(progress, now)) return { progress, unlocked: false };
  const quota = clampNew(settings.newPerDay);
  const fresh = sequence.slice(progress.cursor, progress.cursor + quota)
    .filter((id) => !progress.cards[id]);
  let cogs = [];
  if (settings.cognates) {
    cogs = cognateSequence.slice(progress.cogCursor, progress.cogCursor + COGNATES_PER_DAY)
      .filter((id) => !progress.cards[id]);
  }
  if (fresh.length === 0 && cogs.length === 0 && progress.cursor >= sequence.length) {
    return { progress, unlocked: false };
  }
  const p = clone(progress);
  p.cursor = Math.min(sequence.length, p.cursor + quota);
  if (settings.cognates) p.cogCursor = Math.min(cognateSequence.length, p.cogCursor + COGNATES_PER_DAY);
  p.pending = [...fresh, ...cogs];
  p.lot = [...p.pending];
  p.day = Math.min(totalDays, p.day + 1);
  p.lastUnlock = today;
  return { progress: p, unlocked: true };
}

const t = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));

const reviewCap = (opts) => clampReviews(opts && opts.maxReviews != null ? opts.maxReviews : DEFAULT_SETTINGS.maxReviews);

/** Révisions (état Review) dues aujourd'hui, triées par échéance. */
function dueReviews(progress, now) {
  const eod = endOfDay(now).getTime();
  const ids = [];
  for (const [id, c] of Object.entries(progress.cards)) {
    if (c.state === State.Review && t(c.due) <= eod) ids.push(Number(id));
  }
  return ids.sort((a, b) => t(progress.cards[a].due) - t(progress.cards[b].due) || a - b);
}

const todayAct = (progress, now) => (progress.activity || {})[dayKey(now)] || {};

/** Révisions dues en début de journée (dues restantes + déjà faites aujourd'hui). */
export function backlogToday(progress, now) {
  return dueReviews(progress, now).length + (todayAct(progress, now).rev || 0);
}

/** Vrai si le nouveau lot du jour est retenu à cause des révisions en retard. */
export function isBacklogHeld(progress, now) {
  return backlogToday(progress, now) > BACKLOG_HOLD;
}

/**
 * File du jour : révisions (état Review dues aujourd'hui, plafonnées à `opts.maxReviews` par jour),
 * cartes en (ré)apprentissage dues aujourd'hui, nouvelles cartes attribuées non vues.
 * `later` = révisions dues reportées à plus tard (au-delà du plafond).
 */
export function dailyQueue(progress, now, opts) {
  const eod = endOfDay(now).getTime();
  const all = dueReviews(progress, now);
  const room = Math.max(0, reviewCap(opts) - (todayAct(progress, now).rev || 0));
  const reviews = all.slice(0, room);
  const learning = [];
  for (const [id, c] of Object.entries(progress.cards)) {
    if (t(c.due) > eod) continue;
    if (c.state === State.Learning || c.state === State.Relearning) learning.push(Number(id));
  }
  learning.sort((a, b) => t(progress.cards[a].due) - t(progress.cards[b].due) || a - b);
  const fresh = progress.pending.filter((id) => !progress.cards[id]);
  return {
    reviews, learning, fresh, later: all.length - reviews.length,
    total: reviews.length + learning.length + fresh.length,
  };
}

/**
 * Prochaine carte à montrer :
 * 1. (ré)apprentissage déjà échu (≤ maintenant) ; 2. révisions ; 3. nouvelles ;
 * 4. (ré)apprentissage échu plus tard dans la journée (on avance pour finir la séance).
 * @returns {number|null}
 */
export function pickNext(progress, now, opts) {
  const q = dailyQueue(progress, now, opts);
  const nowMs = t(now);
  const dueLearning = q.learning.find((id) => t(progress.cards[id].due) <= nowMs);
  if (dueLearning !== undefined) return dueLearning;
  if (q.reviews.length) return q.reviews[0];
  if (q.fresh.length) return q.fresh[0];
  if (q.learning.length) return q.learning[0];
  return null;
}

export function isWordsDone(progress, now, opts) {
  return pickNext(progress, now, opts) === null;
}

function touchActivity(p, now, patch) {
  const k = dayKey(now);
  const prev = p.activity[k] || { reviews: 0, story: false, ds: 0, listen: false };
  if (prev.reviews == null) prev.reviews = 0;
  p.activity[k] = patch({ ...prev });
}

/** Applique une note FSRS (Rating.Again ou Rating.Good) à la carte `id`. */
export function rate(progress, id, rating, now, scheduler = createScheduler()) {
  const p = clone(progress);
  const stored = p.cards[id];
  const card = stored ? { ...stored } : createEmptyCard(now);
  const { card: next } = scheduler.next(card, now, rating);
  p.cards[id] = JSON.parse(JSON.stringify(next)); // dates -> ISO
  p.pending = p.pending.filter((x) => x !== id);
  // reviews = réponses données ; rev = mots révisés (carte en état Review) ; nw = mots découverts.
  const wasReview = !!stored && stored.state === State.Review;
  touchActivity(p, now, (a) => ({
    ...a,
    reviews: a.reviews + 1,
    rev: (a.rev || 0) + (wasReview ? 1 : 0),
    nw: (a.nw || 0) + (stored ? 0 : 1),
  }));
  return p;
}

export function markStoryDone(progress, storyDay, now) {
  const p = clone(progress);
  p.stories[storyDay] = dayKey(now);
  touchActivity(p, now, (a) => ({ ...a, story: true }));
  return p;
}

export function logDreaming(progress, minutes, now) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (!m) return progress;
  const p = clone(progress);
  p.dsMinutes = (p.dsMinutes || 0) + m;
  touchActivity(p, now, (a) => ({ ...a, ds: (a.ds || 0) + m }));
  return p;
}

export function markListened(progress, now) {
  const p = clone(progress);
  touchActivity(p, now, (a) => ({ ...a, listen: true }));
  return p;
}

/** Temps passé sur les mots (secondes), pour l'écran de fin de séance. */
export function addStudyTime(progress, seconds, now) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return progress;
  const p = clone(progress);
  touchActivity(p, now, (a) => ({ ...a, sec: (a.sec || 0) + s }));
  return p;
}

/**
 * Temps d'audio écouté (histoire ou écoute en trajet), cumulé dans `audioSec`.
 * Écoute en trajet : l'étape est cochée à partir de LISTEN_DONE_SECONDS dans la journée.
 */
export function addListening(progress, seconds, now, kind = 'listen') {
  const s = Math.max(0, Number(seconds) || 0);
  if (!s) return progress;
  const p = clone(progress);
  p.audioSec = (p.audioSec || 0) + s;
  touchActivity(p, now, (a) => {
    const out = { ...a, audio: (a.audio || 0) + s };
    if (kind === 'listen') {
      out.listenSec = (a.listenSec || 0) + s;
      if (out.listenSec >= LISTEN_DONE_SECONDS) out.listen = true;
    }
    return out;
  });
  return p;
}

/** Minutes d'espagnol écouté : Dreaming Spanish + audio des histoires et de l'écoute. */
export function listeningMinutes(progress) {
  return (progress.dsMinutes || 0) + (progress.audioSec || 0) / 60;
}

function isActive(a) {
  return !!a && (a.reviews > 0 || a.story || a.ds > 0 || a.listen);
}

/** Nombre de jours calendaires avec au moins une activité. */
export function usageDays(activity) {
  return Object.values(activity || {}).filter(isActive).length;
}

/** Jours manqués tolérés : la série ne casse qu'après 2 jours manqués consécutifs. */
export const STREAK_GRACE = 1;

/**
 * Série de jours avec activité, avec une tolérance d'un jour manqué (un jour manqué ne compte pas
 * mais ne casse pas la série ; deux jours manqués de suite la cassent). Si aujourd'hui n'a encore
 * aucune activité, la série compte jusqu'à hier (pas « cassée » avant la fin de la journée).
 */
export function streak(activity, now) {
  let d = new Date(now);
  if (!isActive(activity[dayKey(d)])) d = addDays(d, -1);
  let n = 0;
  let miss = 0;
  for (let guard = 0; guard < 4000; guard += 1) {
    if (isActive(activity[dayKey(d)])) { n += 1; miss = 0; } else if (++miss > STREAK_GRACE) break;
    d = addDays(d, -1);
  }
  return n;
}

/** Meilleure série jamais atteinte (même règle de tolérance). */
export function bestStreak(activity) {
  const keys = Object.keys(activity || {}).filter((k) => isActive(activity[k])).sort();
  if (!keys.length) return 0;
  let best = 0;
  let n = 0;
  let prev = null;
  for (const k of keys) {
    const gap = prev ? Math.round((fromDayKey(k) - fromDayKey(prev)) / 864e5) - 1 : 0;
    n = gap > STREAK_GRACE ? 1 : n + 1;
    best = Math.max(best, n);
    prev = k;
  }
  return best;
}

/** Jours calendaires complets sans activité avant aujourd'hui (0 si actif hier ou jamais actif). */
export function daysAway(activity, now) {
  const today = dayKey(now);
  const keys = Object.keys(activity || {}).filter((k) => k < today && isActive(activity[k])).sort();
  if (!keys.length) return 0;
  return Math.max(0, Math.round((fromDayKey(today) - fromDayKey(keys[keys.length - 1])) / 864e5) - 1);
}

/** Nombre de mots vus au moins une fois (paquet principal + cognats). */
export function wordsLearned(progress) {
  return Object.values(progress.cards).filter((c) => c.state !== State.New).length;
}

/** Semaines d'écoute débloquées : semaine W si au moins 7W−6 lots débloqués. */
export function unlockedWeeks(day, listen) {
  return (listen || []).filter((w) => day >= 7 * w.week - 6);
}

/** État des 4 étapes de l'écran « Aujourd'hui ». */
export function todaySteps(progress, now, opts) {
  const a = progress.activity[dayKey(now)] || {};
  return {
    words: isWordsDone(progress, now, opts),
    story: progress.day > 0 && !!progress.stories[progress.day],
    dreaming: (a.ds || 0) > 0,
    listen: !!a.listen,
  };
}

/** Réponses encore nécessaires pour une carte de la file si tout est su (« Je savais »). */
function answersLeft(c) {
  const step = Number(c.learning_steps) || 0;
  if (c.state === State.Learning) return Math.max(1, LEARNING_STEPS - step);
  if (c.state === State.Relearning) return Math.max(1, RELEARNING_STEPS - step);
  return 1;
}

export const SECONDS_PER_DISCOVERY = 15;
export const SECONDS_PER_REVIEW = 8;

/**
 * Avancement de la séance de mots (estimation si toutes les réponses sont « Je savais ») :
 * - newSeen / newTotal : nouvelles cartes du lot déjà découvertes ;
 * - discoveriesLeft : découvertes restantes ; reviewsLeft : vérifications restantes, y compris
 *   les retours d'apprentissage (une nouvelle carte = 1 découverte + LEARNING_STEPS vérifications) ;
 * - done : réponses données aujourd'hui ; ratio ∈ [0, 1] ; minutes : temps restant estimé.
 */
export function sessionProgress(progress, now, opts) {
  const q = dailyQueue(progress, now, opts);
  const lot = progress.lot || [];
  const newSeen = lot.filter((id) => progress.cards[id]).length;
  const discoveriesLeft = q.fresh.length;
  let reviewsLeft = discoveriesLeft * LEARNING_STEPS;
  for (const id of [...q.reviews, ...q.learning]) reviewsLeft += answersLeft(progress.cards[id]);
  const left = discoveriesLeft + reviewsLeft;
  const done = (progress.activity[dayKey(now)] || {}).reviews || 0;
  const seconds = discoveriesLeft * SECONDS_PER_DISCOVERY + reviewsLeft * SECONDS_PER_REVIEW;
  return {
    newSeen,
    newTotal: newSeen + discoveriesLeft,
    discoveriesLeft,
    reviewsLeft,
    toReview: q.reviews.length + q.learning.length, // mots (distincts) encore à revoir
    later: q.later,
    done,
    ratio: done + left === 0 ? 1 : done / (done + left),
    minutes: left === 0 ? 0 : Math.max(1, Math.round(seconds / 60)),
  };
}

/** Textes du compteur de séance : « 7 / 10 nouveaux mots vus · 12 révisions restantes », « ≈ 3 min ». */
export function sessionLabel(sp) {
  const parts = [];
  if (sp.newTotal > 0) {
    parts.push(`${sp.newSeen} / ${sp.newTotal} ${sp.newTotal > 1 ? 'nouveaux mots vus' : 'nouveau mot vu'}`);
  }
  if (sp.reviewsLeft > 0 || !parts.length) {
    parts.push(`${sp.reviewsLeft} ${sp.reviewsLeft > 1 ? 'révisions restantes' : 'révision restante'}`);
  }
  return { text: parts.join(' · '), time: sp.minutes ? `≈ ${sp.minutes} min` : '' };
}

const minLabel = (m) => `≈ ${m} min`;

/**
 * Résumé de l'étape « Mots », en mots (pas en passages de carte) :
 * « 10 nouveaux mots · 5 à revoir · ≈ 4 min », « 60 mots à revoir · ≈ 8 min · le reste plus tard ».
 * La durée est celle de sessionProgress, identique à celle affichée pendant la séance.
 */
export function wordsLabel(sp) {
  const parts = [];
  const nNew = sp.discoveriesLeft;
  if (nNew > 0) parts.push(nNew > 1 ? `${nNew} nouveaux mots` : '1 nouveau mot');
  if (sp.toReview > 0) parts.push(nNew > 0 ? `${sp.toReview} à revoir` : `${sp.toReview} ${sp.toReview > 1 ? 'mots' : 'mot'} à revoir`);
  if (!parts.length) return 'Terminé pour aujourd’hui';
  if (sp.minutes) parts.push(minLabel(sp.minutes));
  if (sp.later > 0) parts.push('le reste plus tard');
  return parts.join(' · ');
}

/** « Reste ≈ 3 min » pendant la séance. */
export function remainingLabel(sp) {
  return sp.minutes ? `Reste ${minLabel(sp.minutes)}` : '';
}

/** Bilan factuel de la journée : « 45 mots revus · 10 nouveaux · 9 min ». */
export function finishLabel(activityOfDay) {
  const a = activityOfDay || {};
  const rev = a.rev || 0;
  const nw = a.nw || 0;
  const parts = [];
  if (rev) parts.push(`${rev} ${rev > 1 ? 'mots revus' : 'mot revu'}`);
  if (nw) parts.push(rev ? `${nw} ${nw > 1 ? 'nouveaux' : 'nouveau'}` : `${nw} ${nw > 1 ? 'nouveaux mots' : 'nouveau mot'}`);
  if (a.sec) parts.push(`${Math.max(1, Math.round(a.sec / 60))} min`);
  return parts.join(' · ');
}
