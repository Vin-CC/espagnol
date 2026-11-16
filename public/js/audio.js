// Lecteur audio unique (un seul HTMLAudioElement réutilisé pour les mots et les histoires).
// iOS : la lecture n'est autorisée qu'après un geste ; on « débloque » l'élément au premier tap.

const el = new Audio();
el.preload = 'auto';
let unlocked = false;
let token = 0; // invalide les séquences en cours quand une nouvelle lecture démarre

// 0,05 s de silence (WAV PCM 8 kHz) pour débloquer l'élément lors du premier geste.
function silentWav() {
  const n = 400;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i += 1) v.setUint8(44 + i, 128);
  let bin = '';
  new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/** À appeler dans un gestionnaire de geste (tap). Sans effet après le premier appel. */
export function unlock() {
  if (unlocked) return;
  unlocked = true;
  if (el.src) return;
  const silent = silentWav();
  el.src = silent;
  el.play()
    .then(() => { if (el.src === silent) el.pause(); })
    .catch((e) => { if (e && e.name === 'NotAllowedError') unlocked = false; });
}

export function isUnlocked() { return unlocked; }
export const element = el;

export function stop() {
  token += 1;
  el.pause();
}

let rate = 1;
export function setRate(r) {
  rate = r;
  el.defaultPlaybackRate = r;
  el.playbackRate = r;
}
el.addEventListener('play', () => { el.playbackRate = rate; });

/**
 * Joue un fichier ; la promesse se résout avec 'ended', 'error' (fichier absent/illisible)
 * ou 'stopped' (pause, ou autre lecture lancée entre-temps).
 * `onStart` est appelé quand la lecture démarre effectivement.
 */
export function play(url, { onStart } = {}) {
  const my = ++token;
  return new Promise((resolve) => {
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      el.removeEventListener('pause', onPause);
      resolve(res);
    };
    const onEnded = () => finish(my === token ? 'ended' : 'stopped');
    const onError = () => finish(my === token ? 'error' : 'stopped');
    const onPause = () => { if (!el.ended) finish('stopped'); };
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    el.src = url;
    el.playbackRate = rate;
    el.play().then(() => {
      if (my !== token) return finish('stopped');
      el.addEventListener('pause', onPause);
      if (onStart) onStart();
    }).catch((e) => finish(my === token && e && e.name !== 'AbortError' && e.name !== 'NotAllowedError' ? 'error' : 'stopped'));
  });
}

/** Joue plusieurs fichiers à la suite ; s'arrête si une autre lecture prend la main. */
export async function playSequence(urls) {
  for (const u of urls) {
    const my = token + 1;
    const res = await play(u);
    if (res === 'stopped' || token !== my) return false;
  }
  return true;
}

export function currentToken() { return token; }
