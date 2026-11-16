import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../public/js/scheduler.js';
import { dayKey } from '../public/js/dates.js';

const fx = (p) => JSON.parse(readFileSync(new URL(`./fixtures/data/${p}`, import.meta.url), 'utf8'));
const cards = fx('cards.json');
const days = fx('days.json');
const sequence = S.buildSequence(cards, days);
const ctx = { sequence, cognateSequence: S.buildCognateSequence(cards), settings: S.normalizeSettings({}), totalDays: 60 };
const at = (d, h = 9, m = 0) => new Date(2026, 0, d, h, m);
const f = S.createScheduler();

/** Progression avec `n` révisions dues le jour `d` (cartes 1000+), lot précédent entièrement vu. */
function withBacklog(n, d = 10) {
  const p = S.emptyProgress();
  p.day = 2;
  p.lastUnlock = dayKey(at(d - 5));
  p.cursor = 20;
  for (let i = 0; i < n; i += 1) {
    p.cards[1000 + i] = {
      due: at(d - 3, 9, i % 60).toISOString(), state: S.State.Review, stability: 3, difficulty: 5,
      elapsed_days: 0, scheduled_days: 3, learning_steps: 0, reps: 2, lapses: 0, last_review: at(d - 6).toISOString(),
    };
  }
  return p;
}

function doReviews(p, now, count) {
  for (let i = 0; i < count; i += 1) {
    const id = S.pickNext(p, now);
    if (id == null) break;
    p = S.rate(p, id, S.Rating.Good, now, f);
  }
  return p;
}

test('plafond de révisions : 60 par défaut, le reste plus tard', () => {
  const p = withBacklog(100);
  const q = S.dailyQueue(p, at(10));
  assert.equal(q.reviews.length, 60);
  assert.equal(q.later, 40);
  // Les plus anciennes d'abord.
  assert.equal(q.reviews[0], 1000);
  // Réglage (borné 30–150).
  assert.equal(S.dailyQueue(p, at(10), { maxReviews: 30 }).reviews.length, 30);
  assert.equal(S.dailyQueue(p, at(10), { maxReviews: 500 }).reviews.length, 100);
  assert.equal(S.dailyQueue(p, at(10), { maxReviews: 1 }).reviews.length, 30);
  assert.equal(S.normalizeSettings({ maxReviews: 7 }).maxReviews, 30);
  assert.equal(S.normalizeSettings({}).maxReviews, 60);
});

test('plafond par jour : les révisions faites aujourd’hui comptent, la séance se termine', () => {
  let p = withBacklog(100);
  p = doReviews(p, at(10, 9), 25);
  let q = S.dailyQueue(p, at(10, 9));
  assert.equal(q.reviews.length, 35, 'reprise de séance : 60 − 25');
  p = doReviews(p, at(10, 9), 200);
  assert.ok(S.isWordsDone(p, at(10, 9)));
  assert.equal(p.activity[dayKey(at(10))].rev, 60);
  q = S.dailyQueue(p, at(10, 20));
  assert.equal(q.later, 40);
  assert.equal(S.wordsLabel(S.sessionProgress(p, at(10, 20))), 'Terminé pour aujourd’hui');
  // Le lendemain : le reste revient (plafond remis à zéro).
  assert.equal(S.dailyQueue(p, at(11)).reviews.length, 40);
});

test('nouveaux mots retenus tant que les révisions dues dépassent le seuil, sans perdre de jour', () => {
  const p = withBacklog(S.BACKLOG_HOLD + 30);
  assert.ok(S.isBacklogHeld(p, at(10)));
  const r = S.unlockIfNeeded(p, ctx, at(10));
  assert.equal(r.unlocked, false);
  assert.equal(r.progress.day, 2);
  // Toujours retenu le même jour, même après avoir fait les révisions (la séance ne s'allonge pas).
  let p2 = doReviews(p, at(10, 9), 200);
  assert.equal(S.unlockIfNeeded(p2, ctx, at(10, 18)).unlocked, false);
  // Le lendemain, l'arriéré est passé sous le seuil : le lot suivant (jour 4) arrive.
  p2 = doReviews(p2, at(11, 9), 200);
  const next = S.unlockIfNeeded(p2, ctx, at(12, 9));
  assert.ok(next.unlocked);
  assert.equal(next.progress.day, 3, 'aucun jour sauté');
  assert.deepEqual(next.progress.pending, sequence.slice(20, 30));
});

test('seuil non dépassé : le lot est débloqué normalement', () => {
  const p = withBacklog(S.BACKLOG_HOLD);
  assert.equal(S.isBacklogHeld(p, at(10)), false);
  assert.ok(S.unlockIfNeeded(p, ctx, at(10)).unlocked);
});

test('libellés en mots et durée identique accueil/séance', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx, at(1)).progress;
  let sp = S.sessionProgress(p, at(1, 10));
  assert.equal(S.wordsLabel(sp), `10 nouveaux mots · ≈ ${sp.minutes} min`);
  assert.equal(S.remainingLabel(sp), `Reste ≈ ${sp.minutes} min`);
  sp = S.sessionProgress(withBacklog(100), at(10));
  assert.equal(S.wordsLabel(sp), '60 mots à revoir · ≈ 8 min · le reste plus tard');
  assert.equal(S.wordsLabel({ discoveriesLeft: 10, toReview: 5, minutes: 4, later: 0 }), '10 nouveaux mots · 5 à revoir · ≈ 4 min');
  assert.equal(S.wordsLabel({ discoveriesLeft: 1, toReview: 1, minutes: 1, later: 0 }), '1 nouveau mot · 1 à revoir · ≈ 1 min');
  // Bilan : découverte + révision comptées une seule fois par mot.
  p = S.rate(p, p.pending[0], S.Rating.Again, at(1, 10), f);
  p = S.addStudyTime(p, 130, at(1, 10));
  assert.equal(S.finishLabel(p.activity[dayKey(at(1))]), '1 nouveau mot · 2 min');
  assert.equal(S.finishLabel({ rev: 45, nw: 10, sec: 540 }), '45 mots revus · 10 nouveaux · 9 min');
  assert.equal(S.finishLabel({ rev: 1, sec: 20 }), '1 mot revu · 1 min');
});

test('série : record et tolérance d’un jour', () => {
  const act = (ds) => Object.fromEntries(ds.map((d) => [dayKey(at(d)), { reviews: 1 }]));
  assert.equal(S.bestStreak({}), 0);
  assert.equal(S.bestStreak(act([1, 2, 3, 5, 6])), 5);
  assert.equal(S.bestStreak(act([1, 2, 3, 6, 7])), 3);
  // Série cassée : 0 aujourd'hui mais le record est conservé.
  const a = act([1, 2, 3, 4]);
  assert.equal(S.streak(a, at(7)), 0);
  assert.equal(S.bestStreak(a), 4);
  // Un jour manqué hier, rien encore aujourd'hui : la série tient.
  assert.equal(S.streak(act([1, 2, 3]), at(5)), 3);
});

test('absence : jours complets manqués', () => {
  const act = (ds) => Object.fromEntries(ds.map((d) => [dayKey(at(d)), { reviews: 1 }]));
  assert.equal(S.daysAway({}, at(5)), 0);
  assert.equal(S.daysAway(act([1, 2, 3, 4]), at(5)), 0);
  assert.equal(S.daysAway(act([1, 2, 3]), at(5)), 1);
  assert.equal(S.daysAway(act([1, 2, 5]), at(5)), 2, 'l’activité du jour ne compte pas');
  assert.equal(S.daysAway(act([1]), at(7)), 5);
});

test('écoute : étape cochée après 5 min cumulées, heures d’espagnol écouté', () => {
  let p = S.emptyProgress();
  p = S.addListening(p, 200, at(1), 'listen');
  assert.equal(S.todaySteps(p, at(1)).listen, false);
  p = S.addListening(p, 120, at(1), 'listen');
  assert.equal(S.todaySteps(p, at(1)).listen, true);
  p = S.addListening(p, 60, at(1), 'story');
  p = S.logDreaming(p, 45, at(1));
  assert.equal(p.audioSec, 380);
  assert.equal(Math.round(S.listeningMinutes(p) * 60), 45 * 60 + 380);
  // L'audio d'une histoire ne coche pas l'écoute en trajet.
  const q = S.addListening(S.emptyProgress(), 600, at(2), 'story');
  assert.equal(S.todaySteps(q, at(2)).listen, false);
  assert.equal(S.usageDays(q.activity), 0);
});
