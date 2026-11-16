import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../public/js/scheduler.js';
import { dayKey } from '../public/js/dates.js';

const fx = (p) => JSON.parse(readFileSync(new URL(`./fixtures/data/${p}`, import.meta.url), 'utf8'));
const cards = fx('cards.json');
const days = fx('days.json');
const sequence = S.buildSequence(cards, days);
const cognateSequence = S.buildCognateSequence(cards);
const ctx = (settings = {}) => ({ sequence, cognateSequence, settings: S.normalizeSettings(settings), totalDays: days.length });
const at = (d, h = 9, m = 0) => new Date(2026, 0, d, h, m); // dates locales (indépendantes du fuseau)
const f = S.createScheduler();

function rateAll(p, now, rating = S.Rating.Good) {
  let id;
  let guard = 0;
  // eslint-disable-next-line no-cond-assign
  while ((id = S.pickNext(p, now)) !== null && guard++ < 500) p = S.rate(p, id, rating, now, f);
  return p;
}

test('séquence : lots de days.json dans l’ordre puis cartes principales restantes', () => {
  assert.deepEqual(sequence.slice(0, 10), days[0].new);
  assert.deepEqual(sequence.slice(10, 20), days[1].new);
  assert.equal(sequence.length, cards.main.length);
  assert.equal(new Set(sequence).size, sequence.length);
});

test('premier lancement : débloque le lot 1 (jour 1)', () => {
  const { progress, unlocked } = S.unlockIfNeeded(S.emptyProgress(), ctx(), at(1));
  assert.ok(unlocked);
  assert.equal(progress.day, 1);
  assert.deepEqual(progress.pending, days[0].new);
  assert.equal(progress.lastUnlock, dayKey(at(1)));
});

test('un seul lot par jour calendaire, même si le lot est terminé', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx(), at(1)).progress;
  p = rateAll(p, at(1, 10));
  assert.equal(p.pending.length, 0);
  const again = S.unlockIfNeeded(p, ctx(), at(1, 22));
  assert.equal(again.unlocked, false);
  assert.equal(again.progress.day, 1);
  const next = S.unlockIfNeeded(p, ctx(), at(2, 8));
  assert.ok(next.unlocked);
  assert.equal(next.progress.day, 2);
  assert.deepEqual(next.progress.pending, days[1].new);
});

test('pas de nouveau lot tant que les nouvelles cartes précédentes ne sont pas vues', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx(), at(1)).progress;
  p = S.rate(p, p.pending[0], S.Rating.Good, at(1, 10), f); // 1 carte vue sur 10
  const r = S.unlockIfNeeded(p, ctx(), at(3));
  assert.equal(r.unlocked, false);
  assert.equal(r.progress.day, 1);
  assert.equal(S.dailyQueue(r.progress, at(3)).fresh.length, 9);
});

test('jour sauté : le lot suivant est débloqué au retour, sans rattrapage', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx(), at(1)).progress;
  p = rateAll(p, at(1, 10));
  const r = S.unlockIfNeeded(p, ctx(), at(5));
  assert.ok(r.unlocked);
  assert.equal(r.progress.day, 2);
  assert.equal(r.progress.pending.length, 10);
});

test('réglage du nombre de nouvelles cartes (borné 5–20) et cognats', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx({ newPerDay: 5 }), at(1)).progress;
  assert.deepEqual(p.pending, days[0].new.slice(0, 5));
  p = rateAll(p, at(1, 10));
  p = S.unlockIfNeeded(p, ctx({ newPerDay: 99, cognates: true }), at(2)).progress;
  assert.equal(p.pending.length, 20 + S.COGNATES_PER_DAY);
  assert.deepEqual(p.pending.slice(0, 5), days[0].new.slice(5));
  assert.deepEqual(p.pending.slice(20), cognateSequence.slice(0, 5));
  assert.equal(S.clampNew(1), 5);
  assert.equal(S.clampNew('abc'), 10);
});

test('jour plafonné au nombre de lots ; arrêt quand tout est introduit', () => {
  let p = S.emptyProgress();
  for (let d = 1; d <= 10; d += 1) {
    p = S.unlockIfNeeded(p, ctx(), at(d)).progress;
    p = rateAll(p, at(d, 10));
  }
  assert.equal(p.day, days.length);
  assert.equal(p.cursor, sequence.length);
  assert.equal(Object.keys(p.cards).length, sequence.length);
  const r = S.unlockIfNeeded(p, ctx(), at(20));
  assert.equal(r.unlocked, false);
});

test('file du jour : révisions d’abord, puis nouvelles ; apprentissage revient dans la séance', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx(), at(1)).progress;
  const first = S.pickNext(p, at(1, 10));
  assert.equal(first, days[0].new[0]);
  p = S.rate(p, first, S.Rating.Again, at(1, 10), f);
  const c = p.cards[first];
  assert.equal(c.state, S.State.Learning);
  // L’échéance (≈ 1 min) est dans la journée : la carte reste dans la file.
  assert.ok(S.dailyQueue(p, at(1, 10)).learning.includes(first));
  // Avant l’échéance : on passe aux nouvelles cartes.
  assert.equal(S.pickNext(p, at(1, 10)), days[0].new[1]);
  // Après l’échéance : la carte en apprentissage passe devant.
  assert.equal(S.pickNext(p, new Date(Date.parse(c.due) + 1000)), first);
});

test('séance : « Je savais » sur toutes les cartes vide la file (avec retour court terme)', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx(), at(1)).progress;
  let shown = 0;
  let id;
  while ((id = S.pickNext(p, at(1, 10))) !== null) { p = S.rate(p, id, S.Rating.Good, at(1, 10), f); shown += 1; }
  // Chaque nouvelle carte : Good -> Learning (revient), Good -> Review.
  assert.equal(shown, 20);
  assert.ok(S.isWordsDone(p, at(1, 10)));
  for (const cid of days[0].new) assert.equal(p.cards[cid].state, S.State.Review);
  assert.equal(S.wordsLearned(p), 10);
});

test('transitions FSRS : révision due puis oubli (Relearning)', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx(), at(1)).progress;
  p = rateAll(p, at(1, 10));
  const id = days[0].new[0];
  const due = new Date(p.cards[id].due);
  assert.ok(due > at(1, 23, 59));
  // Le lendemain de l’échéance, la carte est dans les révisions du jour.
  const later = new Date(due.getFullYear(), due.getMonth(), due.getDate(), 8);
  const q = S.dailyQueue(p, later);
  assert.ok(q.reviews.includes(id));
  // Une révision due passe avant les nouvelles cartes.
  const p2 = S.unlockIfNeeded(p, ctx(), later).progress;
  assert.ok(p2.pending.length > 0);
  assert.equal(S.dailyQueue(p2, later).reviews[0], S.pickNext(p2, later));
  const p3 = S.rate(p2, id, S.Rating.Again, later, f);
  assert.equal(p3.cards[id].state, S.State.Relearning);
  assert.equal(p3.cards[id].lapses, 1);
  assert.ok(S.dailyQueue(p3, later).learning.includes(id));
});

test('révision due en fin de journée : comptée dès le matin', () => {
  const p = { ...S.emptyProgress(), cards: { 5: { due: at(4, 22).toISOString(), state: S.State.Review, stability: 3, difficulty: 5, elapsed_days: 0, scheduled_days: 3, learning_steps: 0, reps: 2, lapses: 0, last_review: at(1).toISOString() } } };
  assert.deepEqual(S.dailyQueue(p, at(4, 7)).reviews, [5]);
  assert.deepEqual(S.dailyQueue(p, at(3, 23)).reviews, []);
});

test('rate ne modifie pas la progression d’origine et sérialise en JSON', () => {
  const p0 = S.unlockIfNeeded(S.emptyProgress(), ctx(), at(1)).progress;
  const snap = JSON.stringify(p0);
  const p1 = S.rate(p0, p0.pending[0], S.Rating.Good, at(1, 10), f);
  assert.equal(JSON.stringify(p0), snap);
  assert.equal(typeof p1.cards[p0.pending[0]].due, 'string');
  assert.deepEqual(JSON.parse(JSON.stringify(p1)), p1);
  assert.equal(p1.activity[dayKey(at(1))].reviews, 1);
});

test('série de jours consécutifs', () => {
  const act = (keys) => Object.fromEntries(keys.map((d) => [dayKey(at(d)), { reviews: 1 }]));
  assert.equal(S.streak({}, at(5)), 0);
  assert.equal(S.streak(act([3, 4, 5]), at(5)), 3);
  // Aujourd’hui pas encore actif : la série d’hier tient toujours.
  assert.equal(S.streak(act([3, 4]), at(5)), 2);
  // Un trou casse la série.
  assert.equal(S.streak(act([1, 2, 4, 5]), at(5)), 2);
  assert.equal(S.streak(act([1, 2]), at(5)), 0);
  // Les autres activités comptent aussi.
  assert.equal(S.streak({ [dayKey(at(5))]: { reviews: 0, ds: 30 } }, at(5)), 1);
  // Changement de mois.
  const a = { '2026-01-31': { story: true }, '2026-02-01': { listen: true } };
  assert.equal(S.streak(a, new Date(2026, 1, 1, 12)), 2);
});

test('Dreaming Spanish, histoire, écoute : étapes du jour', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx(), at(1)).progress;
  let st = S.todaySteps(p, at(1));
  assert.deepEqual(st, { words: false, story: false, dreaming: false, listen: false });
  p = S.logDreaming(p, '45', at(1));
  p = S.logDreaming(p, 0, at(1));
  p = S.markStoryDone(p, 1, at(1));
  p = S.markListened(p, at(1));
  p = rateAll(p, at(1, 11));
  st = S.todaySteps(p, at(1, 12));
  assert.deepEqual(st, { words: true, story: true, dreaming: true, listen: true });
  assert.equal(p.dsMinutes, 45);
  // Le lendemain : nouvelle histoire à lire, DS à refaire.
  p = S.unlockIfNeeded(p, ctx(), at(2)).progress;
  st = S.todaySteps(p, at(2));
  assert.equal(st.story, false);
  assert.equal(st.dreaming, false);
  assert.equal(st.words, false);
});

test('semaines d’écoute débloquées : semaine W si lots ≥ 7W−6', () => {
  const listen = [1, 2, 3, 9].map((week) => ({ week, file: `listen-w0${week}.mp3`, words: [] }));
  assert.deepEqual(S.unlockedWeeks(0, listen).map((w) => w.week), []);
  assert.deepEqual(S.unlockedWeeks(1, listen).map((w) => w.week), [1]);
  assert.deepEqual(S.unlockedWeeks(7, listen).map((w) => w.week), [1]);
  assert.deepEqual(S.unlockedWeeks(8, listen).map((w) => w.week), [1, 2]);
  assert.deepEqual(S.unlockedWeeks(57, listen).map((w) => w.week), [1, 2, 3, 9]);
  assert.deepEqual(S.unlockedWeeks(5, undefined), []);
});

test('normalisation des réglages et de la progression', () => {
  assert.deepEqual(S.normalizeSettings(null), { ...S.DEFAULT_SETTINGS });
  assert.equal(S.normalizeSettings({ speed: 3 }).speed, 1);
  assert.equal(S.normalizeSettings({ speed: 0.8 }).speed, 0.8);
  const p = S.normalizeProgress({ day: 3, pending: 'x' });
  assert.equal(p.day, 3);
  assert.deepEqual(p.pending, []);
  assert.deepEqual(p.cards, {});
});

test('données réelles : séquence cohérente avec days.json', () => {
  let real;
  try {
    real = {
      cards: JSON.parse(readFileSync(new URL('../public/data/cards.json', import.meta.url), 'utf8')),
      days: JSON.parse(readFileSync(new URL('../public/data/days.json', import.meta.url), 'utf8')),
    };
  } catch { return; } // données absentes : test ignoré
  const seq = S.buildSequence(real.cards, real.days);
  assert.equal(seq.length, real.cards.main.length);
  assert.deepEqual(seq.slice(0, 10), real.days[0].new);
});
