// Stage 1 complement — file watcher ("what you write"). Watches configured directories and
// emits CaptureEvents when text files change. High-signal, low-noise. Opt-in via config
// (files.watch). Pure Node (FSEvents under the hood via fs.watch recursive).
import fs from 'node:fs';
import path from 'node:path';

const TEXT = /\.(md|txt|markdown|js|mjs|cjs|ts|tsx|jsx|py|swift|json|go|rs|java|kt|c|h|cpp|cc|css|scss|html|vue|sql|sh|yaml|yml|toml)$/i;

export function watchFiles(dirs, onEvent, { maxBytes = 4000, debounceMs = 1500 } = {}) {
  const recent = new Map();
  const watchers = [];
  for (const dir of dirs) {
    try {
      watchers.push(fs.watch(path.resolve(dir.replace(/^~/, process.env.HOME || '')), { recursive: true }, (_evt, name) => {
        if (!name || !TEXT.test(name)) return;
        const full = path.join(path.resolve(dir.replace(/^~/, process.env.HOME || '')), name);
        const now = Date.now();
        if (recent.get(full) && now - recent.get(full) < debounceMs) return;
        recent.set(full, now);
        fs.stat(full, (err, st) => {
          if (err || !st.isFile() || st.size > 200_000) return;
          fs.readFile(full, 'utf8', (e, data) => {
            if (e || !data.trim()) return;
            onEvent({ t: now, source: 'file', app: 'Files', window_id: `file|${path.basename(full)}`, text: `${path.basename(full)}: ${data.slice(0, maxBytes)}` });
          });
        });
      }));
    } catch { /* dir missing — skip */ }
  }
  return () => watchers.forEach((w) => w.close());
}
