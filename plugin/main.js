/* =====================================================================
 * Knowledge Galaxy Dashboard — Obsidian plugin
 * ---------------------------------------------------------------------
 * Renders your vault as a 3D galaxy inside an Obsidian view:
 *   - every top-level folder is a planet, subfolders are moons
 *   - HUD cards: overview / knowledge health / vault statistics /
 *     today's tasks / recent notes
 * All data is computed live from the vault (no external script needed).
 * Plain CommonJS, no build step. three.min.js + textures ship in the
 * plugin folder.
 * ===================================================================== */
'use strict';

const { Plugin, ItemView, TFolder, Notice } = require('obsidian');

const VIEW_TYPE = 'galaxy-dashboard-view';
const TREND_DAYS = 14;
const TASK_N = 5;
const TASK_SCAN_MAX = 30;   // at most this many recently-modified notes are read for tasks

let THREE = null;           // cached across view re-opens

/* ---------------------------------------------------------------- */
/* data layer: everything is read from the live vault APIs           */
/* ---------------------------------------------------------------- */
async function collectData(app) {
  const mdFiles = app.vault.getMarkdownFiles();
  const allFiles = app.vault.getFiles();

  /* folders (TFolder count, excluding vault root) */
  const folderCount = app.vault.getAllLoadedFiles()
    .filter(f => f instanceof TFolder && f.path !== '/').length;

  /* tags: '#tag' -> count map from metadataCache */
  const tagMap = app.metadataCache.getTags ? (app.metadataCache.getTags() || {}) : {};
  const tagCount = Object.keys(tagMap).length;

  /* links & orphans from resolvedLinks */
  const resolved = app.metadataCache.resolvedLinks || {};
  let totalLinks = 0;
  const incoming = new Set();
  const outgoingCount = {};
  for (const src of Object.keys(resolved)) {
    let out = 0;
    for (const dst of Object.keys(resolved[src])) {
      const n = resolved[src][dst] || 0;
      out += n;
      if (n > 0) incoming.add(dst);
    }
    outgoingCount[src] = out;
    totalLinks += out;
  }
  const orphans = mdFiles.filter(f =>
    !(outgoingCount[f.path] > 0) && !incoming.has(f.path)).length;

  /* created trend (14d) + created30d via ctime */
  const now = Date.now();
  const dayMs = 86400000;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const trend = new Array(TREND_DAYS).fill(0);
  let created30d = 0;
  for (const f of mdFiles) {
    const age = Math.floor((startOfToday.getTime() + dayMs - f.stat.ctime) / dayMs);
    if (age < 30) created30d++;
    const slot = Math.floor((startOfToday.getTime() + dayMs - 1 - f.stat.ctime) / dayMs);
    if (slot >= 0 && slot < TREND_DAYS) trend[TREND_DAYS - 1 - slot]++;
  }

  /* daily streak: consecutive days (ending today, or yesterday) with edits */
  const editDays = new Set(mdFiles.map(f => {
    const d = new Date(f.stat.mtime); d.setHours(0, 0, 0, 0); return d.getTime();
  }));
  let cursor = startOfToday.getTime();
  if (!editDays.has(cursor)) cursor -= dayMs;
  let streak = 0;
  while (editDays.has(cursor)) { streak++; cursor -= dayMs; }

  /* today updated */
  const todayUpdated = mdFiles.filter(f => f.stat.mtime >= startOfToday.getTime()).length;

  /* recent notes overall */
  const byMtime = [...mdFiles].sort((a, b) => b.stat.mtime - a.stat.mtime);
  const noteInfo = f => ({ title: f.basename, path: f.path, mtime: Math.floor(f.stat.mtime / 1000) });
  const recentAll = byMtime.slice(0, 6).map(noteInfo);

  /* planets: group md files by top-level folder */
  const byFolder = {};
  for (const f of mdFiles) {
    const ix = f.path.indexOf('/');
    if (ix < 0) continue;                    // vault-root notes are not on a planet
    const top = f.path.slice(0, ix);
    (byFolder[top] = byFolder[top] || []).push(f);
  }
  const folders = Object.keys(byFolder).sort().map(name => {
    const files = byFolder[name].sort((a, b) => b.stat.mtime - a.stat.mtime);
    const bySub = {};
    for (const f of files) {
      const rest = f.path.slice(name.length + 1);
      const jx = rest.indexOf('/');
      if (jx < 0) continue;
      const sub = rest.slice(0, jx);
      (bySub[sub] = bySub[sub] || []).push(f);
    }
    const subs = Object.keys(bySub).sort().map(sn => ({
      name: sn, notes: bySub[sn].length,
      recent: bySub[sn].slice(0, 5).map(noteInfo),
    }));
    return { name, notes: files.length, subs, recent: files.slice(0, 8).map(noteInfo) };
  });

  /* open tasks: '- [ ]' lines in notes modified within 7 days */
  const cutoff = now - 7 * dayMs;
  const fresh = byMtime.filter(f => f.stat.mtime >= cutoff).slice(0, TASK_SCAN_MAX);
  const tasks = [];
  const TASK_RE = /^\s*-\s\[\s\]\s+(.+)$/;
  outer: for (const f of fresh) {
    let text = '';
    try { text = await app.vault.cachedRead(f); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      const m = TASK_RE.exec(line);
      if (m) {
        tasks.push({ text: m[1].trim().slice(0, 80), done: false });
        if (tasks.length >= TASK_N) break outer;
      }
    }
  }

  /* health score: 50% linked ratio, 30% link density (2/note = full), 20% streak */
  const notes = mdFiles.length;
  const score = !notes ? 0 : Math.round(100 * (
    0.5 * (1 - orphans / notes) +
    0.3 * Math.min(1, totalLinks / (notes * 2)) +
    0.2 * Math.min(1, streak / 14)));

  const pad = n => String(n).padStart(2, '0');
  const g = new Date();
  return {
    generated: `${g.getFullYear()}-${pad(g.getMonth() + 1)}-${pad(g.getDate())} ${pad(g.getHours())}:${pad(g.getMinutes())}`,
    vault: app.vault.getName(),
    totalNotes: notes,
    todayUpdated,
    health: { score, notes, links: totalLinks, orphans },
    streak: { days: streak },
    stats: {
      files: notes, folders: folderCount, tags: tagCount,
      attachments: allFiles.length - notes, created30d, trend,
    },
    tasks,
    recentAll,
    folders,
  };
}

/* ---------------------------------------------------------------- */
/* view CSS — everything scoped under .kg-root, absolute positioning */
/* ---------------------------------------------------------------- */
const KG_CSS = `
.kg-root{position:relative;width:100%;height:100%;overflow:hidden;background:#04060f;
  color:#dbe7ff;font-family:"Noto Sans SC",-apple-system,sans-serif;user-select:none}
.kg-root canvas.kg-gl{position:absolute;inset:0;display:block}
.kg-labels{position:absolute;inset:0;pointer-events:none;z-index:3;overflow:hidden}
.kg-pl-label{position:absolute;transform:translate(-50%,-100%);text-align:center;
  transition:opacity .4s ease;will-change:left,top;pointer-events:none;white-space:nowrap}
.kg-pl-label .en{font-size:14px;font-weight:700;letter-spacing:.12em;color:var(--c,#fff);
  text-shadow:0 0 14px var(--c,#7dd3fc),0 2px 8px rgba(0,0,0,.8)}
.kg-pl-label .zh{font-size:12px;color:#c3d2ee;margin-top:3px;text-shadow:0 1px 6px rgba(0,0,0,.9)}
.kg-pl-label .zh b{color:var(--c,#7dd3fc);font-weight:600}
.kg-pl-label.hot .en{color:#fff;text-shadow:0 0 18px var(--c,#7dd3fc),0 0 36px var(--c,#7dd3fc)}
.kg-moon-label{position:absolute;transform:translate(-50%,-130%);white-space:nowrap;
  font-size:10.5px;color:#cfe3ff;text-shadow:0 0 8px rgba(0,0,0,.9);
  background:rgba(8,14,30,.55);border:1px solid rgba(125,211,252,.25);
  padding:2px 8px;border-radius:99px;backdrop-filter:blur(4px);pointer-events:none}
.kg-moon-label span{color:#8da3c8;margin-left:4px}
.kg-header{position:absolute;top:14px;left:0;right:0;text-align:center;z-index:4;pointer-events:none}
.kg-header h1{font-size:19px;font-weight:700;letter-spacing:.4em;text-indent:.4em;
  color:#eaf3ff;text-shadow:0 0 30px rgba(125,211,252,.55);margin:0}
.kg-header p{margin:5px 0 0;font-size:10px;letter-spacing:.7em;text-indent:.7em;color:#8da3c8}
.kg-mode{position:absolute;top:18px;right:18px;z-index:4;pointer-events:none;
  font-size:10px;letter-spacing:.22em;color:#7dd3fc}
.kg-mode::before{content:"\\25CF";margin-right:6px;font-size:8px}
.kg-glass{background:rgba(10,18,36,.55);border:1px solid rgba(125,211,252,.16);border-radius:14px;
  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 10px 40px rgba(0,0,0,.45)}
.kg-glass h3{font-size:10.5px;font-weight:600;letter-spacing:.24em;color:#7dd3fc;
  text-transform:uppercase;margin:0 0 10px;display:flex;align-items:center;gap:7px}
.kg-glass h3::before{content:"";flex:none;width:4px;height:4px;border-radius:50%;
  background:#7dd3fc;box-shadow:0 0 6px #7dd3fc}
.kg-hud{opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .6s cubic-bezier(.2,.8,.2,1)}
.kg-root.ready .kg-hud{opacity:1;transform:none}
.kg-col .kg-hud:nth-child(1){transition-delay:.06s}
.kg-col .kg-hud:nth-child(2){transition-delay:.12s}
.kg-col .kg-hud:nth-child(3){transition-delay:.18s}
.kg-col .kg-hud:nth-child(4){transition-delay:.24s}
.kg-col{position:absolute;top:64px;bottom:16px;width:236px;display:flex;flex-direction:column;
  gap:9px;z-index:4;pointer-events:none;transition:opacity .4s;overflow:hidden}
.kg-colL{left:16px}.kg-colR{right:16px}
.kg-col>.kg-glass{position:relative;pointer-events:auto;flex:none;min-height:0;padding:12px 15px}
.kg-root.focused .kg-col,.kg-root.focused .kg-hint{opacity:0;pointer-events:none}
.kg-stat{display:flex;justify-content:space-between;align-items:center;padding:5px 0;
  font-size:12.5px;border-bottom:1px dashed rgba(125,211,252,.1)}
.kg-stat:last-child{border-bottom:none}
.kg-stat b{font-weight:500;color:#fff;font-size:14px}
.kg-kv{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px}
.kg-kv .k{color:#8da3c8;flex:none}
.kg-kv .v{margin-left:auto;color:#dbe7ff;text-align:right;font-size:12px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.kg-kv .v.hl{color:#7dd3fc}
.kg-hwrap{display:flex;gap:12px;align-items:center}
.kg-hwrap svg{flex:none}
.kg-hnum{font-size:19px;font-weight:500;fill:#7ef0c0}
.kg-hlab{font-size:7.5px;letter-spacing:.12em;fill:#8da3c8}
.kg-hlist{flex:1;min-width:0}
.kg-spark{margin-top:8px;height:30px;width:100%;display:block}
.kg-spark polyline{fill:none;stroke:#7dd3fc;stroke-width:1.5;
  filter:drop-shadow(0 0 3px rgba(125,211,252,.7))}
.kg-spark .fillp{fill:rgba(125,211,252,.12);stroke:none}
.kg-task{display:flex;gap:9px;align-items:flex-start;padding:4px 0;font-size:12px;
  cursor:pointer;line-height:1.35;color:#dbe7ff}
.kg-task .box{flex:none;width:13px;height:13px;margin-top:1px;border:1px solid rgba(125,211,252,.4);
  border-radius:4px;position:relative;transition:.2s}
.kg-task.done .box{background:#7dd3fc;border-color:#7dd3fc;box-shadow:0 0 8px rgba(125,211,252,.5)}
.kg-task.done .box::after{content:"";position:absolute;left:3.5px;top:.5px;width:4px;height:8px;
  border:solid #04121e;border-width:0 1.5px 1.5px 0;transform:rotate(40deg)}
.kg-task.done span{color:#8da3c8;text-decoration:line-through}
.kg-note-row{display:flex;justify-content:space-between;align-items:center;gap:10px;
  padding:5px 2px;font-size:12px;cursor:pointer;border-radius:6px;color:#dbe7ff}
.kg-note-row:hover{background:rgba(125,211,252,.08);color:#fff}
.kg-note-row .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kg-note-row .t::before{content:"\\1F4C4";margin-right:6px;font-size:11px}
.kg-note-row .ago{flex:none;font-size:10.5px;color:#8da3c8}
.kg-empty{font-size:11.5px;color:#8da3c8;padding:2px 0}
.kg-hint{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);z-index:4;
  font-size:10.5px;letter-spacing:.18em;color:#8da3c8;pointer-events:none;
  transition:opacity .5s;text-shadow:0 1px 6px rgba(0,0,0,.9);white-space:nowrap}
.kg-refresh{position:absolute;top:14px;right:18px;z-index:7;display:flex;align-items:center;gap:7px;
  padding:7px 14px;border-radius:999px;cursor:pointer;font-size:11px;letter-spacing:.1em;
  color:#7dd3fc;background:rgba(10,18,36,.55);border:1px solid rgba(125,211,252,.16);
  backdrop-filter:blur(14px);transition:.25s;font-family:inherit}
.kg-refresh::before{content:"";width:6px;height:6px;border-radius:50%;background:#7ef0c0;
  box-shadow:0 0 8px #7ef0c0}
.kg-refresh:hover{background:rgba(125,211,252,.14);box-shadow:0 0 18px rgba(125,211,252,.25)}
.kg-refresh.spin::before{animation:kgspin .8s linear infinite}
@keyframes kgspin{50%{opacity:.3}}
.kg-mode-on .kg-refresh{top:14px;right:18px}
.kg-root .kg-mode{top:44px;right:24px}
.kg-back{position:absolute;top:14px;left:18px;z-index:7;display:none;align-items:center;gap:8px;
  padding:8px 18px;border:1px solid rgba(125,211,252,.16);border-radius:99px;cursor:pointer;
  background:rgba(10,18,36,.55);backdrop-filter:blur(14px);color:#7dd3fc;
  font-size:12px;letter-spacing:.12em;font-family:inherit;transition:all .25s}
.kg-back:hover{background:rgba(125,211,252,.15);box-shadow:0 0 24px rgba(125,211,252,.25)}
.kg-root.focused .kg-back{display:flex}
.kg-panel{position:absolute;top:0;right:0;height:100%;width:min(340px,80%);z-index:6;
  background:linear-gradient(200deg,rgba(10,18,38,.92),rgba(5,8,18,.94));
  border-left:1px solid rgba(125,211,252,.16);backdrop-filter:blur(18px);
  transform:translateX(105%);transition:transform .55s cubic-bezier(.22,.9,.3,1);
  display:flex;flex-direction:column}
.kg-panel.open{transform:translateX(0)}
.kg-p-head{padding:56px 24px 18px;border-bottom:1px solid rgba(125,211,252,.12);
  background:radial-gradient(120% 90% at 100% 0%,
    color-mix(in srgb,var(--c) 22%,transparent),transparent 70%)}
.kg-p-eyebrow{font-size:9.5px;letter-spacing:.4em;color:var(--c)}
.kg-p-head h2{font-size:21px;margin:8px 0 0;color:#fff;font-weight:700}
.kg-p-head h2 span{display:block;font-size:11px;letter-spacing:.18em;color:#8da3c8;
  font-weight:500;margin-top:5px}
.kg-p-stats{margin-top:10px;font-size:12px;color:var(--c)}
.kg-p-desc{margin:8px 0 0;font-size:12px;color:#8da3c8;line-height:1.8}
.kg-p-body{flex:1;overflow-y:auto;padding:16px 20px 26px}
.kg-p-section{margin-bottom:20px}
.kg-p-section>h3{font-size:11px;letter-spacing:.22em;color:#7dd3fc;font-weight:500;margin:0 0 9px}
.kg-sub{border:1px solid rgba(125,211,252,.13);border-radius:10px;margin-bottom:8px;
  overflow:hidden;background:rgba(125,211,252,.04)}
.kg-sub-head{display:flex;justify-content:space-between;align-items:center;
  padding:9px 13px;cursor:pointer;font-size:12.5px;color:#eaf3ff}
.kg-sub-head:hover{background:rgba(125,211,252,.08)}
.kg-sub-head .n{font-size:11px;color:var(--c)}
.kg-sub-head .n::after{content:"\\25BE";margin-left:8px;color:#8da3c8;
  display:inline-block;transition:transform .3s}
.kg-sub.open .kg-sub-head .n::after{transform:rotate(180deg)}
.kg-sub-notes{display:none;padding:2px 8px 8px}
.kg-sub.open .kg-sub-notes{display:block}
.kg-sub.flash{animation:kgflash 1.2s ease}
@keyframes kgflash{0%,60%{box-shadow:0 0 0 1px var(--c),0 0 18px var(--c)}100%{box-shadow:none}}
`;

/* ---------------------------------------------------------------- */
/* the view                                                          */
/* ---------------------------------------------------------------- */
class GalaxyDashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.raf = 0;
    this.ro = null;
    this.renderer = null;
    this.scene = null;
    this.disposables = [];
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Knowledge Galaxy'; }
  getIcon() { return 'orbit'; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.style.padding = '0';
    this.contentEl.style.overflow = 'hidden';
    try {
      await this.build();
    } catch (e) {
      console.error('[knowledge-galaxy] failed to open view', e);
      new Notice('Knowledge Galaxy: failed to start — see console.');
    }
  }

  async onClose() {
    this.teardown();
  }

  teardown() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.ro) { this.ro.disconnect(); this.ro = null; }
    if (this.scene) {
      this.scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        mats.forEach(m => {
          for (const k of ['map', 'emissiveMap']) if (m[k]) m[k].dispose();
          m.dispose();
        });
      });
      this.scene = null;
    }
    if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
    this.disposables.forEach(fn => { try { fn(); } catch (e) { /* noop */ } });
    this.disposables = [];
    this.contentEl.empty();
  }

  async refresh() {
    this.teardown();
    await this.build();
  }

  /* ---------- helpers ---------- */
  assetUrl(rel) {
    return this.app.vault.adapter.getResourcePath(`${this.plugin.manifest.dir}/${rel}`);
  }

  async loadThree() {
    if (THREE) return THREE;
    const code = await this.app.vault.adapter.read(`${this.plugin.manifest.dir}/three.min.js`);
    /* shadow module/exports/define so the UMD wrapper takes the global branch */
    new Function('module', 'exports', 'define', 'require', code)(
      undefined, undefined, undefined, undefined);
    THREE = window.THREE;
    if (!THREE) throw new Error('three.min.js did not register window.THREE');
    return THREE;
  }

  async loadConfig() {
    try {
      const code = await this.app.vault.adapter.read(`${this.plugin.manifest.dir}/config.js`);
      const w = {};
      new Function('window', code)(w);
      return w.GALAXY_CONFIG || {};
    } catch (e) {
      console.warn('[knowledge-galaxy] config.js not readable, using defaults', e);
      return {};
    }
  }

  /* ---------- build everything ---------- */
  async build() {
    const app = this.app;
    await this.loadThree();
    const CFG = await this.loadConfig();
    const DATA = await collectData(app);

    const root = this.contentEl.createDiv({ cls: 'kg-root' });
    const style = root.createEl('style'); style.textContent = KG_CSS;

    const esc = s => String(s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const ago = ts => {
      const s = Date.now() / 1000 - ts;
      if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
      return Math.floor(s / 86400 / 30) + 'mo ago';
    };
    const fmt = v => (v === undefined || v === null) ? '—'
      : (typeof v === 'number' ? v.toLocaleString() : v);
    const openNote = p => app.workspace.openLinkText(p, '', false);

    /* ---------- HUD DOM ---------- */
    const header = root.createDiv({ cls: 'kg-header' });
    header.innerHTML = `<h1>${esc(CFG.title || 'KNOWLEDGE GALAXY')}</h1>
      <p>${esc(CFG.subtitle || 'YOUR SECOND BRAIN AS A UNIVERSE')}</p>`;
    const modeEl = root.createDiv({ cls: 'kg-mode', text: 'GALAXY VIEW' });

    const labels = root.createDiv({ cls: 'kg-labels' });

    const colL = root.createDiv({ cls: 'kg-col kg-colL' });
    colL.innerHTML = `
      <aside class="kg-glass kg-hud"><h3>GALAXY OVERVIEW</h3>
        <div class="kg-stat"><span>🪐 Planets</span><b>${DATA.folders.length}</b></div>
        <div class="kg-stat"><span>📄 Total notes</span><b>${DATA.totalNotes}</b></div>
        <div class="kg-stat"><span>✨ Updated today</span><b>${DATA.todayUpdated}</b></div>
        <div class="kg-stat"><span>🛰️ Snapshot</span>
          <span style="font-size:10.5px;color:#8da3c8">${DATA.generated}</span></div>
      </aside>
      <aside class="kg-glass kg-hud"><h3>KNOWLEDGE HEALTH</h3>
        <div class="kg-hwrap">
          <svg width="66" height="66" viewBox="0 0 66 66">
            <circle cx="33" cy="33" r="28" fill="none" stroke="rgba(125,211,252,.12)" stroke-width="4"/>
            <circle class="kg-hring" cx="33" cy="33" r="28" fill="none" stroke="#7ef0c0" stroke-width="4"
              stroke-linecap="round" stroke-dasharray="175.9" stroke-dashoffset="175.9"
              transform="rotate(-90 33 33)" style="transition:stroke-dashoffset 1.4s cubic-bezier(.2,.8,.2,1);
              filter:drop-shadow(0 0 4px rgba(126,240,192,.7))"/>
            <text class="kg-hnum" x="33" y="36" text-anchor="middle">${DATA.health.score}</text>
            <text class="kg-hlab" x="33" y="47" text-anchor="middle">HEALTH</text>
          </svg>
          <div class="kg-hlist">
            <div class="kg-kv"><span class="k">Notes</span><span class="v">${fmt(DATA.health.notes)}</span></div>
            <div class="kg-kv"><span class="k">Connections</span><span class="v">${fmt(DATA.health.links)}</span></div>
            <div class="kg-kv"><span class="k">Orphans</span><span class="v">${fmt(DATA.health.orphans)}</span></div>
            <div class="kg-kv"><span class="k">Daily Streak</span><span class="v hl">${DATA.streak.days} Days</span></div>
          </div>
        </div>
      </aside>
      <aside class="kg-glass kg-hud"><h3>VAULT STATISTICS</h3>
        <div class="kg-kv"><span class="k">Files</span><span class="v">${fmt(DATA.stats.files)}</span></div>
        <div class="kg-kv"><span class="k">Folders</span><span class="v">${fmt(DATA.stats.folders)}</span></div>
        <div class="kg-kv"><span class="k">Tags</span><span class="v">${fmt(DATA.stats.tags)}</span></div>
        <div class="kg-kv"><span class="k">Attachments</span><span class="v">${fmt(DATA.stats.attachments)}</span></div>
        <div class="kg-kv"><span class="k">Created (30d)</span><span class="v hl">${fmt(DATA.stats.created30d)}</span></div>
        <svg class="kg-spark" viewBox="0 0 220 30" preserveAspectRatio="none"></svg>
      </aside>
      <aside class="kg-glass kg-hud"><h3>RECENT NOTES</h3><div class="kg-recent"></div></aside>`;

    const colR = root.createDiv({ cls: 'kg-col kg-colR' });
    colR.innerHTML = `
      <aside class="kg-glass kg-hud"><h3>TODAY'S TASKS</h3><div class="kg-tasks"></div></aside>`;

    /* spark */
    const spark = colL.querySelector('.kg-spark');
    const tr = DATA.stats.trend;
    if (tr && tr.length > 1) {
      const max = Math.max(1, ...tr), W = 220, Hh = 30, P = 2;
      const pts = tr.map((v, i) =>
        `${(i / (tr.length - 1) * W).toFixed(1)},${(Hh - P - v / max * (Hh - 2 * P)).toFixed(1)}`).join(' ');
      spark.innerHTML = `<polygon class="fillp" points="0,${Hh} ${pts} ${W},${Hh}"/><polyline points="${pts}"/>`;
    } else spark.style.display = 'none';

    /* health ring */
    setTimeout(() => {
      const ring = colL.querySelector('.kg-hring');
      if (ring) ring.style.strokeDashoffset =
        (175.9 * (1 - Math.min(100, Math.max(0, DATA.health.score)) / 100)).toFixed(1);
    }, 900);

    /* recent notes */
    const recentEl = colL.querySelector('.kg-recent');
    recentEl.innerHTML = DATA.recentAll.map(n =>
      `<div class="kg-note-row" data-p="${esc(n.path)}">
        <span class="t">${esc(n.title)}</span><span class="ago">${ago(n.mtime)}</span></div>`).join('')
      || '<div class="kg-empty">No notes yet</div>';
    recentEl.onclick = e => {
      const row = e.target.closest('.kg-note-row'); if (row) openNote(row.dataset.p);
    };

    /* tasks */
    const taskEl = colR.querySelector('.kg-tasks');
    const doneStore = JSON.parse(localStorage.getItem('kg-plugin-tasks') || '{}');
    if (!DATA.tasks.length) taskEl.innerHTML = '<div class="kg-empty">No open tasks found</div>';
    DATA.tasks.forEach(t => {
      const el = taskEl.createDiv({ cls: 'kg-task' + (doneStore[t.text] ? ' done' : '') });
      el.innerHTML = `<div class="box"></div><span>${esc(t.text)}</span>`;
      el.onclick = () => {
        el.classList.toggle('done');
        doneStore[t.text] = el.classList.contains('done');
        localStorage.setItem('kg-plugin-tasks', JSON.stringify(doneStore));
      };
    });

    /* refresh + back + hint + panel */
    const refreshBtn = root.createEl('button', { cls: 'kg-refresh', text: 'REFRESH DATA' });
    refreshBtn.onclick = async () => {
      refreshBtn.classList.add('spin');
      await this.refresh();
    };
    const backBtn = root.createEl('button', { cls: 'kg-back' });
    backBtn.innerHTML = '⟵&nbsp; Back to galaxy';
    root.createDiv({ cls: 'kg-hint',
      text: 'Drag to orbit · scroll to zoom · click a planet to enter' });
    const panel = root.createDiv({ cls: 'kg-panel' });
    const pHead = panel.createDiv({ cls: 'kg-p-head' });
    const pBody = panel.createDiv({ cls: 'kg-p-body' });

    /* ---------- 3D scene ---------- */
    const STYLE = CFG.style || {};
    const PALETTE = CFG.palette || ['#7dd3fc', '#a855f7', '#4ade80', '#fbbf24', '#ff6a3d', '#2f6df6'];
    const styleFor = (f, i) => STYLE[f.name] || {
      sub: '', color: PALETTE[i % PALETTE.length], ring: false, desc: 'A folder in your vault.' };

    let cw = Math.max(2, root.clientWidth), ch = Math.max(2, root.clientHeight);

    const scene = this.scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x04060f, 0.0008);
    const camera = new THREE.PerspectiveCamera(55, cw / ch, .1, 2000);
    const HOME_POS = new THREE.Vector3(0, 82, 164);
    camera.position.copy(HOME_POS);
    scene.add(camera);

    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(cw, ch);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.classList.add('kg-gl');
    root.insertBefore(renderer.domElement, labels);

    /* background plane riding the camera (no bloom pipeline in-plugin) */
    let bgPlane = null;
    new THREE.TextureLoader().load(this.assetUrl('assets/bg.jpg'), t => {
      t.colorSpace = THREE.SRGBColorSpace;
      bgPlane = new THREE.Mesh(new THREE.PlaneGeometry(2600, 1460),
        new THREE.MeshBasicMaterial({ map: t, fog: false }));
      bgPlane.position.z = -900;
      camera.add(bgPlane);
    });

    scene.add(new THREE.AmbientLight(0x3a4a78, 1.1));
    scene.add(new THREE.HemisphereLight(0x8899ff, 0x140a24, .55));
    scene.add(new THREE.PointLight(0xffe8c8, 2.4, 0, 0));
    const camLight = new THREE.DirectionalLight(0xbfd4ff, 1.6);
    scene.add(camLight); scene.add(camLight.target);

    const galaxy = new THREE.Group();
    scene.add(galaxy);

    const mulberry = s => () => (s = (s + 0x6D2B79F5) | 0,
      ((Math.imul(s ^ s >>> 15, 1 | s) + Math.imul(s ^ s >>> 7, 61 | s) ^ s) >>> 0) / 4294967296);

    const glowTexture = color => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const x = c.getContext('2d');
      const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, color + 'cc'); g.addColorStop(.35, color + '55'); g.addColorStop(1, color + '00');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    };

    const planetTexture = (hex, seed) => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 256;
      const x = c.getContext('2d'), rnd = mulberry(seed);
      const col = new THREE.Color(hex);
      const shade = k => '#' + col.clone().multiplyScalar(k).getHexString();
      const grad = x.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, shade(.75)); grad.addColorStop(.5, shade(1.35)); grad.addColorStop(1, shade(.6));
      x.fillStyle = grad; x.fillRect(0, 0, 512, 256);
      for (let i = 0; i < 14; i++) {
        x.fillStyle = shade(.5 + rnd() * 1.1) + Math.floor(34 + rnd() * 60).toString(16);
        const y = rnd() * 256; x.fillRect(0, y, 512, 4 + rnd() * 18);
      }
      for (let i = 0; i < 90; i++) {
        x.fillStyle = shade(.45 + rnd() * 1.2) + Math.floor(24 + rnd() * 56).toString(16);
        x.beginPath();
        x.ellipse(rnd() * 512, rnd() * 256, 6 + rnd() * 36, 3 + rnd() * 12, rnd() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };

    /* starfield + nebulae */
    {
      const make = (n, size, rMin, rMax, opacity) => {
        const pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const v = new THREE.Vector3().randomDirection()
            .multiplyScalar(rMin + Math.random() * (rMax - rMin));
          pos.set([v.x, v.y, v.z], i * 3);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfe2ff, size,
          sizeAttenuation: true, transparent: true, opacity, depthWrite: false })));
      };
      make(2400, 1.1, 260, 640, .9); make(1500, .6, 200, 640, .6); make(500, 2.0, 300, 640, .5);
      [['#7c3aed', -260, 40, -340, 420], ['#1d4ed8', 300, -60, -380, 520],
       ['#0e7490', -340, -90, -300, 380], ['#9d174d', 240, 120, -420, 460]]
        .forEach(([col, x, y, z, s]) => {
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(col),
            transparent: true, opacity: .16, depthWrite: false, blending: THREE.AdditiveBlending }));
          sp.position.set(x, y, z); sp.scale.setScalar(s); scene.add(sp);
        });
    }

    /* spiral core */
    {
      const N = 9000, R = 27, branches = 4, spin = 1.25;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const inner = new THREE.Color('#ffc879'), mid = new THREE.Color('#c084fc'),
            outer = new THREE.Color('#5a6cf0');
      for (let i = 0; i < N; i++) {
        const r = Math.pow(Math.random(), 1.45) * R;
        const a = (i % branches) / branches * Math.PI * 2 + r * spin;
        const rd = () => (Math.random() - .5) * Math.pow(Math.random(), 2) * 10 * (1 - r / R * .45);
        pos.set([Math.cos(a) * r + rd(), rd() * .5, Math.sin(a) * r + rd()], i * 3);
        const t = r / R;
        const c = t < .5 ? inner.clone().lerp(mid, t * 2) : mid.clone().lerp(outer, t * 2 - 1);
        col.set([c.r, c.g, c.b], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const core = new THREE.Points(g, new THREE.PointsMaterial({ size: .45, vertexColors: true,
        transparent: true, opacity: .9, depthWrite: false, blending: THREE.AdditiveBlending }));
      core.name = 'core'; galaxy.add(core);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('#ffe2b0'),
        transparent: true, opacity: .85, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.scale.setScalar(26); galaxy.add(halo);
    }

    /* planets */
    const planets = [];
    const maxNotes = Math.max(1, ...DATA.folders.map(f => f.notes));
    const atmVert = `
      varying vec3 vNormal; varying vec3 vPos;
      void main(){
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`;
    const atmFrag = `
      uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uSeed;
      varying vec3 vNormal; varying vec3 vPos;
      float hash(vec3 p){ p = fract(p*.3183099 + .1); p *= 17.;
        return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float noise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.-2.*f);
        return mix(mix(mix(hash(i),            hash(i+vec3(1,0,0)), f.x),
                       mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)), f.x),
                       mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)), f.x), f.y), f.z); }
      void main(){
        vec3 n = normalize(vNormal);
        float rim = pow(1.0 - abs(dot(n, normalize(-vPos))), 2.2);
        float n1 = noise(n*6.0  + vec3(0.0, uTime*.7, uSeed));
        float n2 = noise(n*14.0 - vec3(uTime*.9, 0.0, uSeed*2.0));
        float ridge = 1.0 - abs(2.0*mix(n1, n2, .5) - 1.0);
        float arc = smoothstep(.90, 1.0, ridge) * (.55 + .45*sin(uTime*7.0 + uSeed*10.0));
        float a = rim*.8 + pow(rim, 1.6)*arc*2.4;
        gl_FragColor = vec4(uColor + vec3(.85)*arc*rim, a * uOpacity);
      }`;

    const adapter = app.vault.adapter;
    for (let i = 0; i < DATA.folders.length; i++) {
      const f = DATA.folders[i];
      const st = styleFor(f, i);
      const radius = 4.0 + 4.4 * Math.sqrt(f.notes / maxNotes);
      const orbitR = 36 + i * 11.5;
      const angle0 = i * (Math.PI * 2 / DATA.folders.length) * 3 + .8;

      const pivot = new THREE.Group();
      pivot.rotation.y = angle0;
      galaxy.add(pivot);
      const grp = new THREE.Group();
      grp.position.x = orbitR;
      pivot.add(grp);

      const mat = new THREE.MeshStandardMaterial({
        map: planetTexture(st.color, 1000 + i * 77),
        roughness: .7, metalness: .12,
        emissive: new THREE.Color(st.color).multiplyScalar(.22),
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 48), mat);
      mesh.rotation.z = .15; grp.add(mesh);

      /* high-res texture from plugin assets when one matches the folder name */
      const texName = `assets/${st.tex || f.name}.jpg`;
      adapter.exists(`${this.plugin.manifest.dir}/${texName}`).then(ok => {
        if (!ok || !this.renderer) return;
        new THREE.TextureLoader().load(this.assetUrl(texName), t => {
          t.colorSpace = THREE.SRGBColorSpace;
          mat.map = t;
          mat.emissiveMap = t;
          mat.emissive = new THREE.Color(0xffffff);
          mat.emissiveIntensity = st.boost != null ? st.boost * .5 : .32;
          mat.roughness = .55;
          mat.needsUpdate = true;
        });
      });

      const atmMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(st.color) }, uOpacity: { value: .9 },
                    uTime: { value: 0 }, uSeed: { value: i * 7.3 } },
        vertexShader: atmVert, fragmentShader: atmFrag,
        side: THREE.BackSide, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending });
      grp.add(new THREE.Mesh(new THREE.SphereGeometry(radius * 1.22, 48, 48), atmMat));

      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(st.color),
        transparent: true, opacity: .55, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.setScalar(radius * 3.1); grp.add(glow);

      const ringMats = [];
      if (st.ring) {
        [[1.5, 2.15, .2], [2.25, 2.38, .38]].forEach(([a, b, o]) => {
          const rm = new THREE.MeshBasicMaterial({ color: st.color, side: THREE.DoubleSide,
            transparent: true, opacity: o, depthWrite: false });
          rm.userData = { o };
          const ring = new THREE.Mesh(new THREE.RingGeometry(radius * a, radius * b, 80), rm);
          ring.rotation.x = Math.PI / 2 - .32; grp.add(ring); ringMats.push(rm);
        });
      }

      const orbitMat = new THREE.LineBasicMaterial({ color: 0x3d5a9e, transparent: true, opacity: .16 });
      const pts = [];
      for (let k = 0; k <= 128; k++) {
        const a = k / 128 * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * orbitR, 0, Math.sin(a) * orbitR));
      }
      galaxy.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), orbitMat));

      const label = labels.createDiv({ cls: 'kg-pl-label' });
      label.style.setProperty('--c', st.color);
      label.innerHTML = `<div class="en">${esc(f.name)}</div>
        <div class="zh">${st.sub ? esc(st.sub) + ' · ' : ''}<b>${f.notes}</b> notes</div>`;

      planets.push({ data: f, st, pivot, grp, mesh, glow: glow.material, atm: atmMat,
        ringMats, orbitMat, radius, orbitR, speed: .02, spin: .25 + (i % 3) * .08,
        label, scl: 1 });
    }

    /* ---------- interaction ---------- */
    const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
    let rotY = .4, rotX = .12, tRotY = rotY, tRotX = rotX;
    let camDist = 1, tCamDist = 1;
    let focus = null, moons = [], camAnim = null, hovered = null, drag = null;

    const setPointer = e => {
      const r = root.getBoundingClientRect();
      ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };
    const pick = objs => {
      ray.setFromCamera(ptr, camera);
      const hit = ray.intersectObjects(objs, false)[0];
      return hit ? hit.object : null;
    };
    const uiHit = e => e.target.closest('.kg-col,.kg-panel,.kg-back,.kg-refresh,.kg-header');

    const buildMoons = p => {
      const maxSub = Math.max(1, ...p.data.subs.map(s => s.notes));
      p.data.subs.forEach((s, i) => {
        const pivot = new THREE.Group();
        pivot.rotation.y = i * (Math.PI * 2 / Math.max(1, p.data.subs.length));
        pivot.rotation.x = (i % 2 ? 1 : -1) * .12;
        p.grp.add(pivot);
        const r = .62 + .72 * Math.sqrt(s.notes / maxSub);
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 24),
          new THREE.MeshStandardMaterial({ map: planetTexture(p.st.color, 7000 + i * 31),
            roughness: .85, metalness: .1,
            emissive: new THREE.Color(p.st.color).multiplyScalar(.18) }));
        mesh.position.x = p.radius * 2.1 + (i % 3) * 1.1;
        pivot.add(mesh);
        const label = labels.createDiv({ cls: 'kg-moon-label' });
        label.innerHTML = `${esc(s.name)}<span>${s.notes}</span>`;
        moons.push({ pivot, mesh, label, name: s.name, speed: .5 + i * .13 });
      });
    };

    const buildPanel = p => {
      const st = p.st;
      pHead.style.setProperty('--c', st.color);
      pHead.innerHTML = `
        <div class="kg-p-eyebrow">PLANET${st.sub ? ' / ' + esc(st.sub) : ''}</div>
        <h2>${esc(p.data.name)}<span>${esc(st.sub || '')}</span></h2>
        <div class="kg-p-stats" style="color:${st.color}">
          ${p.data.notes} notes · ${p.data.subs.length} moons (subfolders)</div>
        <p class="kg-p-desc">${esc(st.desc || '')}</p>`;
      const noteRow = n => `<div class="kg-note-row" data-p="${esc(n.path)}">
          <span class="t">${esc(n.title)}</span><span class="ago">${ago(n.mtime)}</span></div>`;
      pBody.innerHTML = `
        <div class="kg-p-section"><h3>🛰️ MOONS · SUBFOLDERS</h3>
          ${p.data.subs.map(s => `
            <div class="kg-sub" data-name="${esc(s.name)}" style="--c:${st.color}">
              <div class="kg-sub-head"><span>📁 ${esc(s.name)}</span>
                <span class="n">${s.notes}</span></div>
              <div class="kg-sub-notes">${s.recent.length
                ? s.recent.map(noteRow).join('')
                : '<div class="kg-empty">No notes yet</div>'}</div>
            </div>`).join('') || '<div class="kg-empty">This planet has no moons yet</div>'}
        </div>
        <div class="kg-p-section"><h3>🕒 RECENT NOTES</h3>
          ${p.data.recent.map(noteRow).join('')}</div>`;
      pBody.onclick = e => {
        const row = e.target.closest('.kg-note-row');
        if (row) return openNote(row.dataset.p);
        const sh = e.target.closest('.kg-sub-head');
        if (sh) sh.parentElement.classList.toggle('open');
      };
    };

    const flashSub = name => {
      const el = pBody.querySelector(`.kg-sub[data-name="${CSS.escape(name)}"]`);
      if (!el) return;
      el.classList.add('open');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    };

    const enterPlanet = p => {
      if (focus === p) return;
      if (focus) {
        moons.forEach(m => { m.pivot.removeFromParent();
          m.mesh.geometry.dispose(); m.label.remove(); });
        moons = [];
      }
      focus = p;
      root.classList.add('focused');
      modeEl.textContent = 'PLANET VIEW — ' + p.data.name;
      planets.forEach(o => { if (o !== p) {
        o.mesh.material.transparent = true;
        o.mesh.material.needsUpdate = true;
        o.fade = { mesh: o.mesh.material, glow: o.glow, orbit: o.orbitMat };
      } });
      buildMoons(p);
      buildPanel(p);
      panel.classList.add('open');
      camAnim = { t: 0, from: camera.position.clone(),
                  fromLook: new THREE.Vector3(0, 0, 0), mode: 'in' };
    };

    const leavePlanet = () => {
      if (!focus) return;
      root.classList.remove('focused');
      panel.classList.remove('open');
      modeEl.textContent = 'GALAXY VIEW';
      moons.forEach(m => { m.pivot.removeFromParent();
        m.mesh.geometry.dispose(); m.label.remove(); });
      moons = [];
      const look = focus.grp.getWorldPosition(new THREE.Vector3());
      camAnim = { t: 0, from: camera.position.clone(), fromLook: look, mode: 'out' };
      focus = null;
    };
    backBtn.onclick = leavePlanet;
    this.registerDomEvent(root, 'keydown', e => { if (e.key === 'Escape') leavePlanet(); });
    root.tabIndex = -1;

    this.registerDomEvent(root, 'pointerdown', e => {
      if (uiHit(e)) return;
      setPointer(e);
      const onPlanet = pick(planets.map(p => p.mesh));
      drag = { x: e.clientX, y: e.clientY, t: Date.now(), moved: 0,
               spinTarget: onPlanet ? planets.find(p => p.mesh === onPlanet) : null };
    });
    this.registerDomEvent(root, 'pointermove', e => {
      setPointer(e);
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        if (drag.spinTarget) {
          drag.spinTarget.mesh.rotation.y += dx * .012;
          drag.spinTarget.mesh.rotation.x += dy * .008;
        } else if (!focus) {
          tRotY += dx * .0045;
          tRotX = THREE.MathUtils.clamp(tRotX + dy * .003, -.25, .75);
        }
        drag.x = e.clientX; drag.y = e.clientY;
      }
    });
    this.registerDomEvent(root, 'pointerup', e => {
      const wasClick = drag && drag.moved < 6 && Date.now() - drag.t < 400;
      drag = null;
      if (!wasClick || uiHit(e)) return;
      setPointer(e);
      if (!focus) {
        const m = pick(planets.map(p => p.mesh));
        if (m) enterPlanet(planets.find(p => p.mesh === m));
      } else {
        const m = pick(moons.map(x => x.mesh));
        if (m) flashSub(moons.find(x => x.mesh === m).name);
      }
    });
    this.registerDomEvent(root, 'pointerleave', () => { drag = null; });
    this.registerDomEvent(root, 'wheel', e => {
      if (e.target.closest('.kg-panel')) return;
      tCamDist = THREE.MathUtils.clamp(tCamDist * (1 + Math.sign(e.deltaY) * .08), .45, 1.9);
    }, { passive: true });

    /* ---------- resize follows the container ---------- */
    this.ro = new ResizeObserver(() => {
      cw = Math.max(2, root.clientWidth); ch = Math.max(2, root.clientHeight);
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      renderer.setSize(cw, ch);
    });
    this.ro.observe(root);

    /* ---------- render loop ---------- */
    const labelPos = new THREE.Vector3();
    const place = (el, obj, yOff, hide) => {
      obj.getWorldPosition(labelPos);
      labelPos.y += yOff;
      labelPos.project(camera);
      const behind = labelPos.z > 1;
      el.style.opacity = (hide || behind) ? 0 : 1;
      if (!behind) {
        el.style.left = (labelPos.x * .5 + .5) * cw + 'px';
        el.style.top = (-labelPos.y * .5 + .5) * ch + 'px';
      }
    };

    const clockV = new THREE.Clock();
    const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const tmpLook = new THREE.Vector3();

    const tick = () => {
      const dt = Math.min(clockV.getDelta(), .05);
      const t = clockV.elapsedTime;

      const core = galaxy.getObjectByName('core');
      if (core) core.rotation.y = t * .02;

      rotY += (tRotY - rotY) * .06; rotX += (tRotX - rotX) * .06;
      galaxy.rotation.y = rotY; galaxy.rotation.x = rotX;
      camDist += (tCamDist - camDist) * .08;

      if (bgPlane) {
        bgPlane.position.x = Math.sin(rotY) * -38;
        bgPlane.position.y = Math.sin(rotX) * -26;
        const k = bgPlane.material.color.r + ((focus ? .35 : 1) - bgPlane.material.color.r) * .06;
        bgPlane.material.color.setScalar(k);
      }

      if (!drag) {
        const m = focus ? null : pick(planets.map(p => p.mesh));
        hovered = m ? planets.find(p => p.mesh === m) : null;
        const moonHit = focus ? pick(moons.map(x => x.mesh)) : null;
        root.style.cursor = (m || moonHit) ? 'pointer' : 'default';
      }

      planets.forEach(p => {
        if (!focus) p.pivot.rotation.y += p.speed * dt;
        if (!drag || drag.spinTarget !== p)
          p.mesh.rotation.y += p.spin * dt * (p === hovered ? 5 : 1);
        const tgt = (p === hovered || p === focus) ? 1.13 : 1;
        p.scl += (tgt - p.scl) * .1; p.grp.scale.setScalar(p.scl);
        const glowTgt = p === focus ? .18 : (p === hovered ? .85 : .55);
        p.glow.opacity += (glowTgt - p.glow.opacity) * .1;

        const dim = focus && p !== focus;
        if (p.fade) {
          p.fade.mesh.opacity += ((dim ? .06 : 1) - p.fade.mesh.opacity) * .07;
          p.fade.orbit.opacity += ((dim ? .03 : .16) - p.fade.orbit.opacity) * .07;
          if (dim) p.fade.glow.opacity = Math.min(p.fade.glow.opacity, .05);
          if (!dim && Math.abs(p.fade.mesh.opacity - 1) < .01) {
            p.fade.mesh.opacity = 1; p.mesh.material.transparent = false;
            p.mesh.material.needsUpdate = true; p.fade = null;
          }
        }
        p.ringMats.forEach(r => r.opacity = dim ? .03 : r.userData.o);
        p.atm.uniforms.uOpacity.value = .9 * p.mesh.material.opacity * (p === focus ? .4 : 1);
        p.atm.uniforms.uTime.value = t;
      });

      moons.forEach(m => {
        m.pivot.rotation.y += m.speed * dt;
        m.mesh.rotation.y += dt;
      });

      if (camAnim) {
        camAnim.t = Math.min(1, camAnim.t + dt / 1.5);
        const k = easeIO(camAnim.t);
        if (camAnim.mode === 'in') {
          const c = focus.grp.getWorldPosition(new THREE.Vector3());
          const dir = c.clone().sub(galaxy.position).setY(0).normalize();
          const dest = c.clone().add(dir.multiplyScalar(focus.radius * 5.2))
            .add(new THREE.Vector3(0, focus.radius * 1.9, 0));
          camera.position.lerpVectors(camAnim.from, dest, k);
          tmpLook.lerpVectors(camAnim.fromLook, c, k);
          camera.lookAt(tmpLook);
          if (camAnim.t >= 1) camAnim = null;
        } else {
          camera.position.lerpVectors(camAnim.from, HOME_POS.clone().multiplyScalar(camDist), k);
          tmpLook.lerpVectors(camAnim.fromLook, new THREE.Vector3(0, 0, 0), k);
          camera.lookAt(tmpLook);
          if (camAnim.t >= 1) camAnim = null;
        }
      } else if (focus) {
        const c = focus.grp.getWorldPosition(new THREE.Vector3());
        const dir = c.clone().sub(galaxy.position).setY(0).normalize();
        camera.position.copy(c).add(dir.multiplyScalar(focus.radius * 5.2 * camDist))
          .add(new THREE.Vector3(0, focus.radius * 1.9 * camDist, 0));
        camera.lookAt(c);
      } else {
        camera.position.copy(HOME_POS).multiplyScalar(camDist);
        camera.lookAt(0, 0, 0);
      }

      camLight.position.copy(camera.position).add(new THREE.Vector3(50, 70, 20));
      camLight.target.position.copy(focus
        ? focus.grp.getWorldPosition(tmpLook) : new THREE.Vector3(0, 0, 0));

      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      planets.forEach(p => {
        const dim = focus && p !== focus;
        place(p.label, p.grp, p.radius * 1.75, dim || (focus === p));
        p.label.classList.toggle('hot', p === hovered);
      });
      moons.forEach(m => place(m.label, m.mesh, .9, false));

      renderer.render(scene, camera);
    };

    const animate = () => {
      this.raf = requestAnimationFrame(animate);
      tick();
    };
    animate();

    setTimeout(() => root.classList.add('ready'), 150);
  }
}

/* ---------------------------------------------------------------- */
/* plugin shell                                                      */
/* ---------------------------------------------------------------- */
module.exports = class KnowledgeGalaxyPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, leaf => new GalaxyDashboardView(leaf, this));

    this.addRibbonIcon('orbit', 'Open Knowledge Galaxy', () => this.activateView());

    this.addCommand({
      id: 'open-galaxy-dashboard',
      name: 'Open Knowledge Galaxy dashboard',
      callback: () => this.activateView(),
    });
  }

  onunload() {
    /* Obsidian detaches leaves of registered view types automatically;
       each view's onClose() does the GL/observer cleanup. */
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
};
