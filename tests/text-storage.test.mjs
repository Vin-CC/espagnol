import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../public/js/text.js';
import * as store from '../public/js/storage.js';

const fx = (p) => JSON.parse(readFileSync(new URL(`./fixtures/data/${p}`, import.meta.url), 'utf8'));
const cards = fx('cards.json');
const story = fx('stories/day-01.json');

test('tokenize : mots (accents, ñ) et séparateurs, texte reconstitué à l’identique', () => {
  const s = '¿Mañana? Dice: «Quiero dormir».';
  const toks = T.tokenize(s);
  assert.equal(toks.map((t) => t.text).join(''), s);
  assert.deepEqual(toks.filter((t) => t.word).map((t) => t.text), ['Mañana', 'Dice', 'Quiero', 'dormir']);
  for (const x of story.sentences) assert.equal(T.tokenize(x.es).map((t) => t.text).join(''), x.es);
});

test('lookupWord : glose en contexte + carte du paquet via lemme ou forme', () => {
  const lex = T.buildLexicon(cards);
  const a = T.lookupWord('Está', story.gloss, lex);
  assert.equal(a.gloss, 'est');
  assert.equal(a.card.lemma, 'estar');
  const b = T.lookupWord('cansado', story.gloss, lex);
  assert.equal(b.gloss, 'fatigué');
  assert.equal(b.card, null);
  const c = T.lookupWord('zzz', story.gloss, lex);
  assert.equal(c.gloss, null);
  assert.equal(c.card, null);
  // Pas de collision avec les propriétés d’objet.
  assert.equal(T.lookupWord('constructor', {}, lex).gloss, null);
});

test('highlightExample : met en gras la forme du mot dans la phrase', () => {
  const ser = cards.main.find((c) => c.lemma === 'ser');
  const segs = T.highlightExample(ser.ex_es, ser);
  assert.deepEqual(segs.filter((s) => s.hit).map((s) => s.text), ['es']);
  assert.equal(segs.map((s) => s.text).join(''), ser.ex_es);
  // Verbe conjugué hors des formes listées : repéré par son radical.
  const hacer = cards.main.find((c) => c.lemma === 'hacer');
  assert.deepEqual(T.highlightExample('¿Qué haces esta noche?', hacer).filter((s) => s.hit).map((s) => s.text), ['haces']);
  // Toutes les cartes de la fixture : le texte est conservé.
  for (const deck of Object.values(cards)) {
    for (const c of deck) assert.equal(T.highlightExample(c.ex_es, c).map((s) => s.text).join(''), c.ex_es);
  }
});

test('storyFile et collectAudio', () => {
  assert.equal(T.storyFile(3), 'data/stories/day-03.json');
  assert.equal(T.storyFile(60), 'data/stories/day-60.json');
  const files = T.collectAudio(cards, [story], fx('listen.json'));
  assert.ok(files.includes(cards.main[0].a_word));
  assert.ok(files.includes('story-01-01.mp3'));
  assert.ok(files.includes('listen-w02.mp3'));
  assert.equal(new Set(files).size, files.length);
});

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  };
}

test('export / import : aller-retour et validation', () => {
  const st = fakeStorage({ 'ed:v1:progress': '{"day":3}', 'ed:v1:settings': '{"newPerDay":12}', autre: 'x' });
  const snap = store.snapshot(st);
  assert.deepEqual(Object.keys(snap).sort(), ['ed:v1:progress', 'ed:v1:settings']);
  const exp = store.buildExport(snap, new Date('2026-01-01T00:00:00Z'));
  const r = store.parseImport(JSON.stringify(exp));
  assert.ok(r.ok);
  const target = fakeStorage({ 'ed:v1:old': '1', autre: 'x' });
  store.restore(r.data, target);
  assert.equal(target.getItem('ed:v1:old'), null);
  assert.equal(target.getItem('autre'), 'x');
  assert.deepEqual(JSON.parse(target.getItem('ed:v1:progress')), { day: 3 });

  assert.equal(store.parseImport('pas du json').ok, false);
  assert.equal(store.parseImport('{"app":"autre","data":{}}').ok, false);
  assert.equal(store.parseImport({ app: store.APP_ID, data: { x: 1 } }).ok, false);
});

test('clearAll ne touche que les clés ed:v1:*', () => {
  const st = fakeStorage({ 'ed:v1:a': '1', 'ed:v1:b': '2', autre: 'x' });
  store.clearAll(st);
  assert.deepEqual([...st.map.keys()], ['autre']);
});

test('bulle : pas de traduction répétée, comparaison mot à mot normalisée', () => {
  const card = { lemma: 'tener', fr: 'avoir', ff: false };
  assert.ok(T.containsWords('avoir, posséder', 'Avoir'));
  assert.ok(!T.containsWords('avoir', 'a'));
  // Glose identique à la carte (même mot) : une seule ligne.
  assert.deepEqual(T.bubbleInfo({ word: 'tener', gloss: 'avoir', card }), { gloss: 'avoir', lemma: null, cardFr: null, ff: false });
  // Forme conjuguée : glose + lemme seulement.
  assert.deepEqual(T.bubbleInfo({ word: 'tiene', gloss: 'il a', card: { lemma: 'tener', fr: 'avoir ; il a', ff: false } }),
    { gloss: 'il a', lemma: 'tener', cardFr: null, ff: false });
  // Traductions différentes : les deux.
  assert.deepEqual(T.bubbleInfo({ word: 'tiene', gloss: 'il a', card }), { gloss: 'il a', lemma: 'tener', cardFr: 'avoir', ff: false });
  // Sans glose : la carte.
  assert.deepEqual(T.bubbleInfo({ word: 'tener', gloss: null, card }), { gloss: null, lemma: null, cardFr: 'avoir', ff: false });
  assert.equal(T.frTitle({ title: 'Don Ramón', title_fr: 'Don Ramón' }), '');
  assert.equal(T.frTitle({ title: 'Don Ramon', title_fr: 'don ramón' }), '');
  assert.equal(T.frTitle({ title: 'La llegada', title_fr: 'L’arrivée' }), 'L’arrivée');
});
