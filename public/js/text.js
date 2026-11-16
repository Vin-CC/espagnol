// Découpage du texte espagnol et recherche de traductions (module pur).

const WORD_RE = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;

/** Découpe une phrase en segments { text, word } (mots et séparateurs). */
export function tokenize(sentence) {
  const out = [];
  let last = 0;
  for (const m of String(sentence).matchAll(WORD_RE)) {
    if (m.index > last) out.push({ text: sentence.slice(last, m.index), word: false });
    out.push({ text: m[0], word: true });
    last = m.index + m[0].length;
  }
  if (last < sentence.length) out.push({ text: sentence.slice(last), word: false });
  return out;
}

export function norm(word) {
  return String(word).toLocaleLowerCase('es').normalize('NFC');
}

/**
 * Index forme -> carte pour toutes les cartes (lemme + formes).
 * Priorité : paquet principal, mots-outils, puis cognats (la première entrée gagne).
 */
export function buildLexicon(cardsData) {
  const lex = new Map();
  for (const deck of ['main', 'function_words', 'cognates']) {
    for (const c of cardsData[deck] || []) {
      for (const f of [c.lemma, ...(c.forms || [])]) {
        const k = norm(f);
        if (k && !lex.has(k)) lex.set(k, c);
      }
    }
  }
  return lex;
}

/** Minuscules sans accents (comparaison de radicaux). */
function bare(word) {
  return norm(word).normalize('NFD').replace(/\p{M}/gu, '');
}

/** Traduction d'un mot d'histoire : glose en contexte et/ou carte du paquet. */
export function lookupWord(word, gloss, lexicon) {
  const k = norm(word);
  const g = gloss && Object.prototype.hasOwnProperty.call(gloss, k) ? gloss[k] : null;
  const card = lexicon ? lexicon.get(k) || null : null;
  return { word: k, gloss: g, card };
}

/**
 * Segments de la phrase exemple avec le mot de la carte marqué (`hit: true`) :
 * lemme ou l'une de ses formes, insensible à la casse.
 */
export function highlightExample(sentence, card) {
  const targets = new Set([card.lemma, ...(card.forms || [])].map(norm));
  const multi = [...targets].filter((x) => /\s/.test(x));
  const segs = tokenize(sentence).map((s) => ({ ...s, hit: s.word && targets.has(norm(s.text)) }));
  if (segs.some((s) => s.hit)) return segs;
  // Verbes conjugués absents des formes listées : même radical (lemme sans -ar/-er/-ir).
  if (/(ar|er|ir|ír)(se)?$/.test(norm(card.lemma))) {
    const stem = bare(card.lemma).replace(/(ar|er|ir)(se)?$/, '');
    const i = stem.length >= 3 ? segs.findIndex((s) => s.word && bare(s.text).startsWith(stem)) : -1;
    if (i >= 0) { segs[i].hit = true; return segs; }
  }
  if (!multi.length) return segs;
  // Lemmes de plusieurs mots : recherche directe dans la phrase.
  const low = norm(sentence);
  for (const m of multi) {
    const i = low.indexOf(m);
    if (i >= 0) {
      return [
        { text: sentence.slice(0, i), word: false, hit: false },
        { text: sentence.slice(i, i + m.length), word: true, hit: true },
        { text: sentence.slice(i + m.length), word: false, hit: false },
      ].filter((s) => s.text);
    }
  }
  return segs;
}

/** « 3 » -> « day-03.json ». */
export function storyFile(day) {
  return `data/stories/day-${String(day).padStart(2, '0')}.json`;
}

/** Liste dédoublonnée de tous les fichiers audio référencés. */
export function collectAudio(cardsData, stories = [], listen = []) {
  const set = new Set();
  for (const deck of Object.values(cardsData || {})) {
    for (const c of deck || []) {
      if (c.a_word) set.add(c.a_word);
      if (c.a_ex) set.add(c.a_ex);
    }
  }
  for (const s of stories) for (const x of (s && s.sentences) || []) if (x.audio) set.add(x.audio);
  for (const w of listen || []) if (w.file) set.add(w.file);
  return [...set];
}
