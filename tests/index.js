// Point d'entrée pour `node --test tests/` (Node 22 résout le dossier vers ce fichier).
// `node --test tests/*.test.mjs` fonctionne aussi.
import './scheduler.test.mjs';
import './text-storage.test.mjs';
import './session-backup.test.mjs';
import './backlog-streak.test.mjs';
import './guide-data.test.mjs';
