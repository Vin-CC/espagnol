import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../public/js/scheduler.js';
import * as store from '../public/js/storage.js';

const fx = (p) => JSON.parse(readFileSync(new URL(`./fixtures/data/${p}`, import.meta.url), 'utf8'));
const cards = fx('cards.json');
const days = fx('days.json');
const ctx = { sequence: S.buildSequence(cards, days), cognateSequence: S.buildCognateSequence(cards), settings: S.normalizeSettings({}), totalDays: days.length };
const at = (d, h = 9, m = 0) => new Date(2026, 0, d, h, m);
const f = S.createScheduler();
const later = (p, id) => new Date(Date.parse(p.cards[id].due) + 1000);

test('découverte : « Compris » = Again, la carte revient dans la séance puis est vérifiée', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx, at(1)).progress;
  assert.deepEqual(p.lot, days[0].new);
  const id = S.pickNext(p, at(1, 10));
  p = S.rate(p, id, S.Rating.Again, at(1, 10), f);
  assert.equal(p.cards[id].state, S.State.Learning);
  assert.ok(!p.pending.includes(id));
  assert.deepEqual(p.lot, days[0].new, 'le lot garde la trace des cartes vues');
  // Quelques minutes plus tard, la carte repasse en tête : elle est alors testée normalement.
  const t2 = later(p, id);
  assert.equal(S.pickNext(p, t2), id);
  p = S.rate(p, id, S.Rating.Good, t2, f);
  p = S.rate(p, id, S.Rating.Good, later(p, id), f);
  assert.equal(p.cards[id].state, S.State.Review);
});

test('compteur de séance : avance à chaque réponse et finit à 100 %', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx, at(1)).progress;
  let sp = S.sessionProgress(p, at(1, 10));
  assert.equal(sp.newSeen, 0);
  assert.equal(sp.newTotal, 10);
  assert.equal(sp.discoveriesLeft, 10);
  assert.equal(sp.reviewsLeft, 10 * S.LEARNING_STEPS);
  assert.equal(sp.ratio, 0);
  assert.ok(sp.minutes > 0);
  assert.deepEqual(S.sessionLabel(sp), { text: `0 / 10 nouveaux mots vus · ${10 * S.LEARNING_STEPS} révisions restantes`, time: `≈ ${sp.minutes} min` });

  // Séance complète : découverte (Again) puis « Je savais », en avançant l'horloge comme un vrai utilisateur.
  let t = at(1, 10);
  let prev = sp.ratio;
  let id;
  let guard = 0;
  while ((id = S.pickNext(p, t)) !== null && guard++ < 200) {
    const c = p.cards[id];
    if (c && Date.parse(c.due) > t.getTime()) t = later(p, id);
    p = S.rate(p, id, c ? S.Rating.Good : S.Rating.Again, t, f);
    sp = S.sessionProgress(p, t);
    assert.ok(sp.ratio > prev, `la barre avance (${prev} -> ${sp.ratio})`);
    prev = sp.ratio;
  }
  assert.equal(sp.newSeen, 10);
  assert.equal(sp.ratio, 1);
  assert.equal(sp.minutes, 0);
  assert.equal(sp.done, 10 * (1 + S.LEARNING_STEPS), 'estimation exacte quand tout est su');
});

test('compteur : « À revoir » sur une vérification ne fait pas reculer la barre', () => {
  let p = S.unlockIfNeeded(S.emptyProgress(), ctx, at(1)).progress;
  const id = S.pickNext(p, at(1, 10));
  p = S.rate(p, id, S.Rating.Again, at(1, 10), f);
  const t = later(p, id);
  const before = S.sessionProgress(p, t);
  p = S.rate(p, id, S.Rating.Again, t, f);
  const after = S.sessionProgress(p, t);
  assert.equal(after.reviewsLeft, before.reviewsLeft);
  assert.ok(after.ratio > before.ratio);
});

test('libellé du compteur : singuliers, sans nouveaux mots', () => {
  assert.equal(S.sessionLabel({ newSeen: 0, newTotal: 1, reviewsLeft: 1, minutes: 1 }).text, '0 / 1 nouveau mot vu · 1 révision restante');
  assert.equal(S.sessionLabel({ newSeen: 0, newTotal: 0, reviewsLeft: 12, minutes: 2 }).text, '12 révisions restantes');
  assert.equal(S.sessionLabel({ newSeen: 10, newTotal: 10, reviewsLeft: 0, minutes: 0 }).text, '10 / 10 nouveaux mots vus');
});

test('ancienne progression sans lot : le lot est déduit des cartes en attente', () => {
  const p = S.normalizeProgress({ day: 1, pending: [1, 2], cards: {} });
  assert.deepEqual(p.lot, [1, 2]);
});

test('jours d’utilisation', () => {
  assert.equal(S.usageDays({}), 0);
  assert.equal(S.usageDays({ '2026-01-01': { reviews: 3 }, '2026-01-02': { reviews: 0, story: false, ds: 0 }, '2026-01-03': { ds: 20 } }), 2);
});

test('rappel de sauvegarde : 2 jours d’usage, export > 7 jours, « Plus tard » = 3 jours', () => {
  const t = new Date('2026-03-10T09:00:00Z');
  const daysAgo = (n) => new Date(t.getTime() - n * 864e5).toISOString();
  // Jamais exporté
  assert.equal(store.needsBackupReminder({}, 1, t), false);
  assert.equal(store.needsBackupReminder({}, 2, t), true);
  assert.equal(store.needsBackupReminder(null, 5, t), true);
  // Dernier export
  assert.equal(store.needsBackupReminder({ lastExport: daysAgo(6) }, 30, t), false);
  assert.equal(store.needsBackupReminder({ lastExport: daysAgo(7) }, 30, t), false);
  assert.equal(store.needsBackupReminder({ lastExport: daysAgo(7.1) }, 30, t), true);
  // Plus tard
  const snoozed = store.snoozeBackup({ lastExport: daysAgo(10) }, t);
  assert.equal(store.needsBackupReminder(snoozed, 30, t), false);
  assert.equal(store.needsBackupReminder(snoozed, 30, new Date(t.getTime() + 2.9 * 864e5)), false);
  assert.equal(store.needsBackupReminder(snoozed, 30, new Date(t.getTime() + 3.1 * 864e5)), true);
  // Export : enregistre la date et annule le report
  const done = store.markExported(snoozed, t);
  assert.equal(done.lastExport, t.toISOString());
  assert.equal(done.backupSnoozeUntil, null);
  assert.equal(store.needsBackupReminder(done, 30, new Date(t.getTime() + 8 * 864e5)), true);
});
