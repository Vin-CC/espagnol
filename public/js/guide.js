// Accompagnement : consigne de la semaine, fiches de grammaire, prompts d'aide.
// Module pur (aucun accès au DOM) : importable par Node pour les tests.

/** Semaine du programme : W = ceil(jour / 7), au moins 1. */
export function weekOf(day) {
  return Math.max(1, Math.ceil((Number(day) || 0) / 7));
}

/** Consigne de la semaine du jour `day` (data/weeks.json : [{ weeks: [W…], text, sheet?, help? }]). */
export function weekTip(weeks, day) {
  const w = weekOf(day);
  return (weeks || []).find((x) => Array.isArray(x.weeks) && x.weeks.includes(w)) || null;
}

/** Fiche débloquée si le jour courant ≥ son jour de déblocage. */
export function isSheetUnlocked(sheet, day) {
  return !!sheet && (Number(day) || 0) >= (sheet.unlock || 1);
}

/** Fiches débloquées (ordre du fichier) et prochaine fiche verrouillée. */
export function sheetsFor(grammar, day) {
  const list = grammar || [];
  return {
    unlocked: list.filter((s) => isSheetUnlocked(s, day)),
    next: list.find((s) => !isSheetUnlocked(s, day)) || null,
  };
}

/** Texte avec **gras** → segments [{ text, bold }]. */
export function richSegments(str) {
  return String(str || '').split('**').map((text, i) => ({ text, bold: i % 2 === 1 })).filter((s) => s.text);
}

/** Prompts à copier dans Claude (Réglages › Aide). */
export const PROMPTS = Object.freeze([
  {
    id: 'correction',
    title: 'Corriger 3 phrases écrites',
    use: 'Écris 3 phrases sur ta journée, colle ce prompt dans Claude, puis ajoute tes phrases à la fin.',
    text: `Je suis francophone et débutant en espagnol (niveau A1). Voici 3 phrases que j'ai écrites sur ma journée.
Pour chaque phrase :
1. Donne la phrase corrigée.
2. Pour chaque erreur, explique-la en français en une seule ligne.
3. Propose une version plus naturelle, comme la dirait un Espagnol.
Reste simple et court : pas de cours de grammaire.

Mes phrases :
1.
2.
3.`,
  },
  {
    id: 'conversation',
    title: 'Conversation à voix haute (10 min)',
    use: 'Dans l’appli Claude, ouvre le mode vocal, colle ce prompt, puis parle.',
    text: `Sois mon partenaire de conversation en espagnol. Je suis francophone et grand débutant (A1). On parle à l'oral pendant environ 10 minutes.
Règles :
- Parle uniquement un espagnol très simple : phrases courtes, mots fréquents.
- Pose-moi des questions sur ma vie (journée, travail, famille, goûts, projets), une seule à la fois.
- Si je ne comprends pas, reformule plus simplement en espagnol.
- Ne corrige que les erreurs qui gênent la compréhension : redis alors ma phrase correctement, sans t'attarder.
- Ne dis un mot en français que si je bloque vraiment.
- Fais des réponses brèves : je dois parler plus que toi.
Commence par me saluer et me poser une question simple.`,
  },
]);
