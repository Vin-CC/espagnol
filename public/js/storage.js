// Stockage local (clés « ed:v1:* ») et sauvegarde/restauration.
// Les fonctions d'export/import sont pures et testables ; load/save utilisent localStorage si présent.

export const PREFIX = 'ed:v1:';
export const APP_ID = 'espanol-diario';

function ls() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function load(name, fallback = null) {
  const s = ls();
  if (!s) return fallback;
  try {
    const raw = s.getItem(PREFIX + name);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function save(name, value) {
  const s = ls();
  if (!s) return false;
  try { s.setItem(PREFIX + name, JSON.stringify(value)); return true; } catch { return false; }
}

/** Toutes les clés ed:v1:* -> valeurs (désérialisées). */
export function snapshot(storage = ls()) {
  const data = {};
  if (!storage) return data;
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (k && k.startsWith(PREFIX)) {
      try { data[k] = JSON.parse(storage.getItem(k)); } catch { /* clé illisible ignorée */ }
    }
  }
  return data;
}

export function buildExport(data, now = new Date()) {
  return { app: APP_ID, version: 1, exportedAt: new Date(now).toISOString(), data };
}

/**
 * Valide un export (texte JSON ou objet). Renvoie { ok, data } ou { ok: false, error }.
 */
export function parseImport(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch { return { ok: false, error: 'Ce texte n’est pas un JSON valide.' }; }
  }
  if (!obj || obj.app !== APP_ID || typeof obj.data !== 'object' || obj.data === null) {
    return { ok: false, error: 'Ce fichier n’est pas une sauvegarde « Español diario ».' };
  }
  const data = {};
  for (const [k, v] of Object.entries(obj.data)) if (k.startsWith(PREFIX)) data[k] = v;
  if (!Object.keys(data).length) return { ok: false, error: 'La sauvegarde est vide.' };
  return { ok: true, data };
}

/** Remplace toutes les clés ed:v1:* par celles de `data`. */
export function restore(data, storage = ls()) {
  if (!storage) return false;
  clearAll(storage);
  for (const [k, v] of Object.entries(data)) storage.setItem(k, JSON.stringify(v));
  return true;
}

export function clearAll(storage = ls()) {
  if (!storage) return;
  const keys = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  keys.forEach((k) => storage.removeItem(k));
}

// ---------- Rappel de sauvegarde (fonctions pures sur l'objet « meta ») ----------
const DAY_MS = 24 * 60 * 60 * 1000;
export const BACKUP_EVERY_DAYS = 7;    // rappel si le dernier export a plus de 7 jours
export const BACKUP_SNOOZE_DAYS = 3;   // « Plus tard » masque le rappel 3 jours
export const BACKUP_MIN_USE_DAYS = 2;  // jamais exporté : rappel après 2 jours d'utilisation

/**
 * Faut-il afficher le rappel « Sauvegarde ta progression » ?
 * @param {{lastExport?: string|null, backupSnoozeUntil?: string|null}} meta
 * @param {number} usedDays jours calendaires avec activité
 */
export function needsBackupReminder(meta, usedDays, now = new Date()) {
  const m = meta || {};
  const t = new Date(now).getTime();
  if (m.backupSnoozeUntil && Date.parse(m.backupSnoozeUntil) > t) return false;
  if (m.lastExport) return t - Date.parse(m.lastExport) > BACKUP_EVERY_DAYS * DAY_MS;
  return usedDays >= BACKUP_MIN_USE_DAYS;
}

export function snoozeBackup(meta, now = new Date()) {
  return { ...(meta || {}), backupSnoozeUntil: new Date(new Date(now).getTime() + BACKUP_SNOOZE_DAYS * DAY_MS).toISOString() };
}

export function markExported(meta, now = new Date()) {
  return { ...(meta || {}), lastExport: new Date(now).toISOString(), backupSnoozeUntil: null };
}
