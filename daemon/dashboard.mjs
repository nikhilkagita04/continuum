// `continuum verify` dashboard — a tiny local web page (no deps, no network) showing the
// timeline of what Continuum captured + a live search box. The 60-second "it works" proof.
import http from 'node:http';
import fs from 'node:fs';
import { buildDeps } from './config.mjs';
import { loadEpisodes, loadIndex, STORE_FILE } from './store.mjs';

const { embed } = buildDeps();
const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Timeline reads the store fresh on every request (always current). The search index is
// rebuilt only when the store file changes, so new captures appear without a restart.
const mtime = () => { try { return fs.statSync(STORE_FILE).mtimeMs; } catch { return 0; } };
let index = null, indexedAt = -1;
async function freshIndex() { const m = mtime(); if (!index || m !== indexedAt) { index = await loadIndex(embed); indexedAt = m; } return index; }

const HTML = `<!doctype html><html lang=en><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>Continuum</title>
<style>
:root{--bg:#fff;--fg:#0a0a0a;--muted:#6b7280;--border:#ececec;--card:#fafafa;--accent:#6366f1}
@media(prefers-color-scheme:dark){:root{--bg:#0b0b0c;--fg:#f4f4f5;--muted:#9ca3af;--border:#1e1e22;--card:#141417;--accent:#818cf8}}
*{box-sizing:border-box}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--fg);max-width:680px;margin:0 auto;padding:56px 20px}
h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0}
.sub{color:var(--muted);font-size:14px;margin:4px 0 26px}
input{width:100%;padding:12px 14px;font:inherit;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:12px;outline:none;transition:border-color .15s}
input:focus{border-color:var(--accent)}
.rows{margin-top:20px;display:flex;flex-direction:column;gap:8px}
.row{padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--card)}
.app{font-weight:600;font-size:13px;color:var(--accent);margin-bottom:2px}
.score{float:right;font-weight:400;color:var(--muted)}
.empty{color:var(--muted);margin-top:24px}
code{background:var(--card);border:1px solid var(--border);padding:2px 6px;border-radius:6px;font-size:13px}
</style>
<h1>Continuum</h1>
<div class=sub>What your machine captured — local, private, yours.</div>
<input id=q placeholder="Search your context…  e.g. what was I emailing about?" autofocus>
<div id=out class=rows></div>
<script>
const out=document.getElementById('out'),q=document.getElementById('q');
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const render=rows=>out.innerHTML=rows.length?rows.map(r=>'<div class=row><div class=app>'+esc(r.app)+(r.score!=null?'<span class=score>'+r.score+'</span>':'')+'</div><div>'+esc(r.text)+'</div></div>').join(''):'<div class=empty>Nothing captured yet. Run <code>continuum start</code>.</div>';
const timeline=()=>fetch('/api/timeline').then(r=>r.json()).then(render);
let t;q.oninput=()=>{clearTimeout(t);t=setTimeout(()=>{const v=q.value.trim();v?fetch('/api/search?q='+encodeURIComponent(v)).then(r=>r.json()).then(render):timeline();},180);};
timeline();
setInterval(()=>{if(!q.value.trim())timeline();},3000);  // live refresh while not searching
</script>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/timeline') return json(res, loadEpisodes().slice(-50).reverse().map((e) => ({ app: e.app, text: (e.text || '').slice(0, 240), score: null })));
  if (u.pathname === '/api/search') {
    const hits = await (await freshIndex()).search(u.searchParams.get('q') || '', { k: 8 });
    return json(res, hits.map((h) => ({ app: h.ep.app, text: h.ep.text.slice(0, 240), score: Number(h.score.toFixed(3)) })));
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML);
});

const PORT = process.env.CONTINUUM_PORT || 3939;
server.listen(PORT, () => console.error(`continuum dashboard → http://localhost:${PORT}`));
