import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as G from '../public/js/guide.js';
import * as S from '../public/js/scheduler.js';
import * as T from '../public/js/text.js';

const data = (p) => JSON.parse(readFileSync(new URL(`../public/data/${p}`, import.meta.url), 'utf8'));
const weeks = data('weeks.json');
const grammar = data('grammar.json');

test('semaine du programme : W = ceil(jour / 7)', () => {
  assert.equal(G.weekOf(0), 1);
  assert.equal(G.weekOf(1), 1);
  assert.equal(G.weekOf(7), 1);
  assert.equal(G.weekOf(8), 2);
  assert.equal(G.weekOf(35), 5);
  assert.equal(G.weekOf(36), 6);
  assert.equal(G.weekOf(60), 9);
});

test('consigne de la semaine : une par semaine 1–9, fiches existantes', () => {
  const ids = new Set(grammar.map((s) => s.id));
  for (let d = 1; d <= 60; d += 1) {
    const tip = G.weekTip(weeks, d);
    assert.ok(tip && tip.text, `jour ${d}`);
    if (tip.sheet) assert.ok(ids.has(tip.sheet), tip.sheet);
  }
  assert.equal(G.weekTip(weeks, 1).sheet, 'ser-estar');
  assert.equal(G.weekTip(weeks, 8).sheet, 'present');
  assert.equal(G.weekTip(weeks, 21).sheet, 'gustar');
  assert.equal(G.weekTip(weeks, 22).sheet, 'passe');
  assert.equal(G.weekTip(weeks, 29).help, true);
  assert.equal(G.weekTip(weeks, 60).help, true);
  assert.equal(G.weekTip([], 3), null);
  // La fiche annoncée est débloquée pendant toute sa semaine.
  for (let d = 1; d <= 60; d += 1) {
    const tip = G.weekTip(weeks, d);
    if (tip.sheet) assert.ok(G.isSheetUnlocked(grammar.find((s) => s.id === tip.sheet), d), `jour ${d}`);
  }
});

test('fiches : déblocage aux jours 1, 8, 15, 21 ; ≤ 150 mots ; 3–5 exemples', () => {
  assert.deepEqual(grammar.map((s) => [s.id, s.unlock]), [['ser-estar', 1], ['present', 8], ['gustar', 15], ['passe', 21]]);
  assert.deepEqual(G.sheetsFor(grammar, 7).unlocked.map((s) => s.id), ['ser-estar']);
  assert.equal(G.sheetsFor(grammar, 7).next.id, 'present');
  assert.deepEqual(G.sheetsFor(grammar, 21).unlocked.map((s) => s.id), ['ser-estar', 'present', 'gustar', 'passe']);
  assert.equal(G.sheetsFor(grammar, 21).next, null);
  assert.equal(G.sheetsFor(null, 3).unlocked.length, 0);
  for (const s of grammar) {
    const text = [...s.body, ...s.examples.flatMap((e) => [e.es, e.fr])].join(' ');
    assert.ok(text.split(/\s+/).length <= 150, `${s.id} trop long`);
    assert.ok(s.examples.length >= 3 && s.examples.length <= 5, s.id);
    for (const e of s.examples) {
      if (e.audio) assert.ok(existsSync(new URL(`../public/audio/${e.audio}`, import.meta.url)), e.audio);
    }
  }
});

test('texte riche : **gras**', () => {
  assert.deepEqual(G.richSegments('a **b** c'), [{ text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false }]);
  assert.deepEqual(G.richSegments(''), []);
});

test('prompts d’aide : correction et conversation', () => {
  assert.deepEqual(G.PROMPTS.map((p) => p.id), ['correction', 'conversation']);
  for (const p of G.PROMPTS) assert.ok(p.text.length > 100);
});

test('données : mots-outils hors cognats, no/a ajoutés, una forme de uno', () => {
  const cards = data('cards.json');
  const FUNC = new Set(['prep', 'pron', 'conj', 'art', 'determiner', 'contraction']);
  assert.deepEqual(cards.cognates.filter((c) => FUNC.has(c.pos)).map((c) => c.lemma), []);
  const fw = new Map(cards.function_words.map((c) => [c.lemma, c]));
  for (const w of ['de', 'en', 'que', 'se', 'tú', 'no', 'a']) assert.ok(fw.has(w), w);
  assert.ok(fw.get('tú').forms.includes('te'));
  const all = Object.values(cards).flat();
  assert.equal(new Set(all.map((c) => c.id)).size, all.length, 'identifiants uniques');
  assert.equal(all.filter((c) => c.lemma === 'una').length, 0, 'pas de carte « una » en double');
  const lex = T.buildLexicon(cards);
  assert.equal(lex.get('una').lemma, 'uno');
  assert.equal(lex.get('no').lemma, 'no');
  assert.equal(lex.get('te').lemma, 'tú');
  // Audio absent toléré (a_word vide) : pas de nom vide dans la liste de téléchargement.
  assert.ok(!T.collectAudio(cards).includes(''));
});

test('données : lots sans mots vulgaires, 10 mots par jour, sans doublon', () => {
  const cards = data('cards.json');
  const days = data('days.json');
  const lemma = new Map(Object.values(cards).flat().map((c) => [c.id, c.lemma]));
  const ids = days.flatMap((d) => d.new);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(days.every((d) => d.new.length === S.NEW_PER_DAY));
  for (const bad of ['puta', 'joder', 'carajo']) assert.ok(!ids.some((id) => lemma.get(id) === bad), bad);
  assert.ok(days[33].new.includes(992) && days[40].new.includes(993)); // iniciar (j34), diario (j41)
  const main = new Set(cards.main.map((c) => c.id));
  assert.ok(ids.every((id) => main.has(id)));
});
