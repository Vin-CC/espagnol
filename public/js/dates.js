// Utilitaires de dates en heure locale (module pur, importable par Node).

/** Clé de jour calendaire local « AAAA-MM-JJ ». */
export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const j = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${j}`;
}

/** Fin du jour local (23:59:59.999) contenant `date`. */
export function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Ajoute `n` jours calendaires (robuste aux changements d'heure). */
export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Date locale (midi) à partir d'une clé « AAAA-MM-JJ ». */
export function fromDayKey(key) {
  const [y, m, j] = key.split('-').map(Number);
  return new Date(y, m - 1, j, 12);
}
