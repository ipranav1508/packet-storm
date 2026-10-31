// PACKET STORM: browser client.
// The C# server owns the simulation (30 Hz). This file only sends inputs, interpolates snapshots and draws them.
'use strict';

const $ = (s) => document.querySelector(s);
const TAU = Math.PI * 2;
const W = 960, H = 600;
const cv = $('#cv');
const ctx = cv.getContext('2d');
ctx.setTransform(2, 0, 0, 2, 0, 0);

const ENEMY_COLOR = ['#ff8a3d', '#ffd84a', '#b46bff', '#e9fbff', '#ff3d5a', '#ff2bd6'];
const TOWER_COLOR = ['#ff6b3d', '#4db8ff', '#4dff9a', '#3de0ff'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let cfg = null;
const G = {
  mode: 'menu',            // menu | live | replay
  ws: null,
  snap: null, prev: null, tRecv: 0,
  buildKind: null, selId: null,
  mouse: { x: W / 2, y: 250, down: false, inside: false },
  firing: false, lastAim: '',
  beams: [], parts: [], floats: [], rings: [],
  shake: 0, flash: 0, banner: null,
  muted: false, lastShotId: 0, lastKillSound: 0, lastShotSound: 0,
  replayId: null, lastRun: null,
};

// ---------------------------------------------------------------------------- sound
let AC = null;
function beep(freq, dur = 0.08, type = 'square', vol = 0.035, slide = 0) {
  if (G.muted) return;
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const t = AC.currentTime;
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(AC.destination);
    o.start(t); o.stop(t + dur);
  } catch { /* audio is optional */ }
}

// ---------------------------------------------------------------------------- toast
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------------------- network
function connect(url) {
  closeSocket();
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + url);
  G.ws = ws;
  ws.onmessage = (e) => {
    if (G.ws !== ws) return;
    const m = JSON.parse(e.data);
    if (m.type === 'state') onState(m);
    else if (m.type === 'over') onOver(m);
  };
  ws.onclose = () => {
    if (G.ws !== ws) return;
    G.ws = null;
    if ((G.mode === 'live' || G.mode === 'replay') && !(G.snap && G.snap.over)) {
      toast('Connection lost');
      showMenu();
    }
  };
}
function closeSocket() {
  if (G.ws) { const w = G.ws; G.ws = null; try { w.close(); } catch { /* ignore */ } }
}
function send(obj) {
  if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------- game flow
function resetFx() {
  G.snap = G.prev = null;
  G.beams = []; G.parts = []; G.floats = []; G.rings = [];
  G.shake = G.flash = 0; G.banner = null;
  G.buildKind = null; G.selId = null; G.firing = false; G.lastAim = ''; G.lastShotId = 0;
}

function startGame() {
  const name = $('#inName').value.trim() || 'Operator';
  const seedRaw = $('#inSeed').value.trim();
  try { localStorage.setItem('psName', name); } catch { /* ignore */ }
  resetFx();
  G.mode = 'live';
  G.lastRun = null;
  hideOverlays();
  setHud(true);
  connect(`/ws/play?name=${encodeURIComponent(name)}${seedRaw ? '&seed=' + encodeURIComponent(seedRaw) : ''}`);
  buildShop();
  beep(330, 0.12, 'sawtooth', 0.04, 440);
}

function startReplay(id) {
  resetFx();
  G.mode = 'replay';
  G.replayId = id;
  hideOverlays();
  setHud(true);
  connect(`/ws/replay?id=${encodeURIComponent(id)}`);
}

function setHud(on) {
  $('#hud').classList.toggle('hidden', !on);
  const live = G.mode === 'live';
  $('#shop').classList.toggle('hidden', !on || !live);
  $('#liveTools').classList.toggle('hidden', !live);
  $('#replayTools').classList.toggle('hidden', G.mode !== 'replay');
  if (!on) $('#towerPanel').classList.add('hidden');
}

function hideOverlays() { $('#menu').classList.add('hidden'); $('#over').classList.add('hidden'); }

function showMenu() {
  closeSocket();
  G.mode = 'menu';
  resetFx();
  setHud(false);
  $('#over').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  loadBoard();
}

function onState(m) {
  G.prev = G.snap;
  G.snap = m;
  G.tRecv = performance.now();
  for (const f of m.fx) handleFx(f);
  for (const s of m.shots) {
    if (s[0] > G.lastShotId) {
      G.lastShotId = s[0];
      if (performance.now() - G.lastShotSound > 90) { G.lastShotSound = performance.now(); beep(880, 0.04, 'triangle', 0.015, -300); }
    }
  }
  if (G.selId && !m.towers.some((t) => t[0] === G.selId)) G.selId = null;
  updateHud();
}

function onOver(m) {
  G.lastRun = m;
  setTimeout(() => showOver(m), 900);
}

// ---------------------------------------------------------------------------- effects from the server
function handleFx(f) {
  switch (f[0]) {
    case 'beam': {
      const kind = f[5];
      G.beams.push({ x1: f[1], y1: f[2], x2: f[3], y2: f[4], color: TOWER_COLOR[kind], life: kind === 2 ? 0.2 : 0.1, max: kind === 2 ? 0.2 : 0.1, w: kind === 2 ? 3 : kind === 3 ? 2.5 : 1.5, kind });
      break;
    }
    case 'boom': {
      const col = f[4] === 'lb' ? '#3de0ff' : f[4] === 'sell' ? '#ffd84a' : '#ffffff';
      G.rings.push({ x: f[1], y: f[2], r: f[3], life: 0.25, max: 0.25, color: col });
      if (f[4] === 'lb') beep(140, 0.12, 'sawtooth', 0.03, -60);
      break;
    }
    case 'kill': {
      const kind = f[3];
      burst(f[1], f[2], ENEMY_COLOR[kind], kind === 5 ? 60 : kind === 4 ? 26 : 14);
      G.floats.push({ x: f[1], y: f[2] - 8, text: '+' + Math.round(f[4] * 0.7), life: 0.9, max: 0.9, color: '#ffd84a' });
      if (kind === 5) { G.shake = Math.max(G.shake, 10); beep(90, 0.5, 'sawtooth', 0.06, -50); }
      if (performance.now() - G.lastKillSound > 45) { G.lastKillSound = performance.now(); beep(420 + Math.random() * 120, 0.06, 'square', 0.025, -200); }
      break;
    }
    case 'leak':
      G.shake = Math.max(G.shake, 8 + f[3] * 2);
      G.flash = 0.5;
      beep(110, 0.3, 'sawtooth', 0.07, -60);
      break;
    case 'flush':
      G.rings.push({ x: f[1], y: f[2], r: f[3], life: 0.5, max: 0.5, color: '#3de0ff', thick: true });
      G.rings.push({ x: f[1], y: f[2], r: f[3] * 0.6, life: 0.35, max: 0.35, color: '#ffffff', thick: true });
      G.shake = Math.max(G.shake, 6);
      beep(200, 0.45, 'sawtooth', 0.06, 500);
      break;
    case 'build':
      G.rings.push({ x: f[1], y: f[2], r: 30, life: 0.3, max: 0.3, color: '#4dff9a' });
      beep(520, 0.1, 'triangle', 0.04, 300);
      break;
    case 'wave':
      G.banner = { text: 'WAVE ' + f[1], sub: f[2] ? 'BOTNET INCOMING' : 'INBOUND TRAFFIC', t: 0, boss: f[2] };
      beep(f[2] ? 120 : 260, 0.35, 'sawtooth', 0.05, f[2] ? 60 : 200);
      break;
    case 'clear':
      G.banner = { text: 'WAVE ' + f[1] + ' CLEARED', sub: '+' + f[2] + ' credits', t: 0, good: true };
      beep(660, 0.2, 'triangle', 0.04, 330);
      break;
    case 'msg':
      toast(f[1]);
      beep(150, 0.12, 'square', 0.03);
      break;
  }
}

function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, sp = 40 + Math.random() * 140;
    G.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5 + Math.random() * 0.4, max: 0.9, color, size: 1.5 + Math.random() * 2.5 });
  }
}

// ---------------------------------------------------------------------------- HUD
const FORCE_TEXT = ['Bot', 'Swarm', 'SQL Injection', 'Zero-day', 'Ransomware', 'Botnet'];

function updateHud() {
  const s = G.snap;
  if (!s) return;
  $('#hWave').textContent = `${s.wave}/${s.maxWave}`;
  $('#hCore').style.width = Math.max(0, s.core) + '%';
  $('#hCredits').textContent = s.credits;
  $('#hScore').textContent = s.score;
  $('#hKills').textContent = s.kills;
  $('#flushFill').style.width = (s.flush * 100) + '%';
  $('#btnPause').classList.toggle('on', s.paused);
  $('#btnReplayPause').classList.toggle('on', s.paused);
  $('#btnNext').disabled = s.waveActive || s.wave >= s.maxWave;

  const parts = Object.entries(s.next).map(([k, n]) => `<span class="pill">${n}× ${esc(k)}</span>`).join('');
  const status = s.waveActive ? 'Wave in progress' : (s.wave >= s.maxWave ? 'Final wave cleared' : `Next wave in ${s.intermission}s`);
  $('#incoming').innerHTML = `<span class="status">${status}${s.waveActive || !parts ? '' : ' · incoming:'}</span>${s.waveActive ? '' : parts}`;

  if (G.mode === 'live') refreshShopState();
  refreshTowerPanel();
}

function buildShop() {
  if (!cfg) return;
  $('#shop').innerHTML = cfg.towers.map((t, i) => `
    <button class="shop-btn" data-kind="${i}" title="${esc(t.blurb)}">
      <b>${esc(t.name)} <kbd>${i + 1}</kbd></b><span>₡${t.cost}</span>
    </button>`).join('');
}

function refreshShopState() {
  const credits = G.snap ? G.snap.credits : 0;
  document.querySelectorAll('.shop-btn').forEach((b) => {
    const k = +b.dataset.kind;
    b.classList.toggle('sel', G.buildKind === k);
    b.classList.toggle('poor', credits < cfg.towers[k].cost);
  });
}

function selectedTower() {
  if (!G.selId || !G.snap) return null;
  const t = G.snap.towers.find((x) => x[0] === G.selId);
  return t ? { id: t[0], kind: t[1], pad: t[2], level: t[3] } : null;
}

function investedOf(t) {
  const def = cfg.towers[t.kind];
  let sum = def.cost;
  for (let l = 1; l < t.level; l++) sum += def.upgrade[l - 1];
  return sum;
}

function refreshTowerPanel() {
  const el = $('#towerPanel');
  const t = G.mode === 'live' ? selectedTower() : null;
  if (!t) { el.classList.add('hidden'); return; }
  const def = cfg.towers[t.kind];
  const cost = t.level < 3 ? def.upgrade[t.level - 1] : null;
  el.classList.remove('hidden');
  el.innerHTML = `
    <h3 style="color:${TOWER_COLOR[t.kind]}">${esc(def.name)} · LEVEL ${t.level}</h3>
    <div class="row">
      <button class="btn" data-act="upgrade" ${cost === null || G.snap.credits < cost ? 'disabled' : ''}>${cost === null ? 'MAX' : 'UPGRADE ₡' + cost} <kbd>U</kbd></button>
      <button class="btn ghost" data-act="sell">SELL ₡${Math.floor(investedOf(t) * 0.6)} <kbd>S</kbd></button>
    </div>`;
}

// ---------------------------------------------------------------------------- menu / leaderboard
async function loadBoard() {
  const el = $('#board');
  try {
    const rows = await (await fetch('/api/leaderboard')).json();
    if (!rows.length) { el.innerHTML = '<p style="color:var(--dim)">No runs yet. Be the first.</p>'; return; }
    el.innerHTML = rows.map((r, i) => `
      <div class="rowx">
        <span>${i + 1}</span><span>${esc(r.name)}${r.victory ? ' 🏆' : ''}</span><span>${r.score}</span><span>W${r.wave}</span>
        <span><button class="btn ghost small" data-replay="${esc(r.replayId)}">▶ Replay</button>
        <button class="btn ghost small" data-verify="${esc(r.replayId)}">Verify</button><span class="v" id="v-${esc(r.replayId)}"></span></span>
      </div>`).join('');
  } catch { el.textContent = 'Leaderboard unavailable.'; }
}

async function verify(id, targetEl) {
  targetEl.textContent = '…';
  targetEl.className = 'v';
  try {
    const r = await (await fetch(`/api/replays/${encodeURIComponent(id)}/verify`)).json();
    if (r.ok && r.verified) { targetEl.textContent = `✔ ${r.recomputed}`; }
    else { targetEl.textContent = '✖ mismatch'; targetEl.classList.add('bad'); }
  } catch { targetEl.textContent = 'error'; targetEl.classList.add('bad'); }
}

function showOver(m) {
  if (G.mode === 'menu') return;
  const replay = !!m.replay;
  const title = m.victory ? 'CLUSTER SECURED' : 'CLUSTER BREACHED';
  $('#overCard').innerHTML = `
    <h1 style="font-size:30px;letter-spacing:.12em;color:${m.victory ? 'var(--green)' : 'var(--red)'}">${replay ? 'REPLAY FINISHED' : title}</h1>
    <div class="big-score">${m.score}</div>
    <div class="stats">Wave ${m.wave} of ${cfg.maxWave} · ${m.kills} packets destroyed</div>
    <div class="stack">
      ${replay ? '' : '<button class="btn" id="oPlay">PLAY AGAIN</button>'}
      <button class="btn ghost" id="oReplay">▶ ${replay ? 'Watch again' : 'Watch my replay'}</button>
      <button class="btn ghost" id="oVerify">Verify score on server <span class="v" id="oV"></span></button>
      <button class="btn ghost" id="oMenu">MENU</button>
    </div>
    <p style="color:var(--dim);font-size:12px;margin:12px 0 0">Replays are saved only for top-20 runs. The server re-simulates seed + inputs to confirm the score.</p>`;
  $('#over').classList.remove('hidden');
  $('#oPlay')?.addEventListener('click', () => { $('#over').classList.add('hidden'); startGame(); });
  $('#oReplay').addEventListener('click', () => startReplay(m.replayId));
  $('#oVerify').addEventListener('click', () => verify(m.replayId, $('#oV')));
  $('#oMenu').addEventListener('click', showMenu);
}

// ---------------------------------------------------------------------------- input
function toLogical(e) {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
}

function padAt(x, y) {
  let best = -1, bd = 26;
  cfg.pads.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
  return best;
}

function towerAt(x, y) {
  if (!G.snap) return null;
  for (const t of G.snap.towers) {
    const p = cfg.pads[t[2]];
    if (Math.hypot(p[0] - x, p[1] - y) < 22) return t;
  }
  return null;
}

cv.addEventListener('pointermove', (e) => {
  const p = toLogical(e);
  G.mouse.x = p.x; G.mouse.y = p.y; G.mouse.inside = true;
});
cv.addEventListener('pointerleave', () => { G.mouse.inside = false; G.firing = false; });
cv.addEventListener('contextmenu', (e) => { e.preventDefault(); cancelSelection(); });
cv.addEventListener('pointerdown', (e) => {
  if (G.mode !== 'live' || !G.snap || G.snap.over || e.button === 2) return;
  const p = toLogical(e);
  G.mouse.x = p.x; G.mouse.y = p.y; G.mouse.down = true;
  cv.setPointerCapture?.(e.pointerId);

  if (G.buildKind !== null) {
    const pad = padAt(p.x, p.y);
    if (pad >= 0) send({ t: 'build', pad, kind: G.buildKind });
    return;
  }
  const tw = towerAt(p.x, p.y);
  if (tw) { G.selId = tw[0]; refreshTowerPanel(); return; }
  G.selId = null;
  refreshTowerPanel();
  G.firing = true;
});
window.addEventListener('pointerup', () => { G.mouse.down = false; G.firing = false; });
window.addEventListener('blur', () => { G.mouse.down = false; G.firing = false; });

function cancelSelection() { G.buildKind = null; G.selId = null; G.firing = false; refreshShopState(); refreshTowerPanel(); }

function doFlush() {
  if (G.mode !== 'live') return;
  const m = G.mouse.inside ? G.mouse : { x: W / 2, y: 250 };
  send({ t: 'flush', x: Math.round(m.x), y: Math.round(m.y) });
}

function chooseBuild(k) {
  if (G.mode !== 'live') return;
  G.buildKind = G.buildKind === k ? null : k;
  G.selId = null;
  refreshShopState();
  refreshTowerPanel();
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') { if (e.key === 'Enter' && G.mode === 'menu') startGame(); return; }
  const k = e.key.toLowerCase();
  if (G.mode === 'live') {
    if (k >= '1' && k <= '4') chooseBuild(+k - 1);
    else if (k === 'escape') cancelSelection();
    else if (k === ' ') { e.preventDefault(); doFlush(); }
    else if (k === 'n') send({ t: 'nextwave' });
    else if (k === 'p') send({ t: 'pause' });
    else if (k === 'u' && G.selId) send({ t: 'upgrade', id: G.selId });
    else if (k === 's' && G.selId) send({ t: 'sell', id: G.selId });
  } else if (G.mode === 'replay') {
    if (k === 'p' || k === ' ') { e.preventDefault(); send({ t: 'pause' }); }
  }
  if (k === 'm') toggleMute();
});

function toggleMute() { G.muted = !G.muted; $('#btnMute').classList.toggle('on', G.muted); $('#btnMute').textContent = G.muted ? '✕' : '♪'; }

document.addEventListener('click', (e) => {
  const shop = e.target.closest('.shop-btn');
  if (shop) return chooseBuild(+shop.dataset.kind);
  const act = e.target.closest('[data-act]');
  if (act && G.selId) { send({ t: act.dataset.act, id: G.selId }); return; }
  const rp = e.target.closest('[data-replay]');
  if (rp) return startReplay(rp.dataset.replay);
  const vf = e.target.closest('[data-verify]');
  if (vf) return verify(vf.dataset.verify, document.getElementById('v-' + vf.dataset.verify));
  const sp = e.target.closest('.spd');
  if (sp) { send({ t: 'speed', id: +sp.dataset.speed }); document.querySelectorAll('.spd').forEach((b) => b.classList.toggle('on', b === sp)); }
});
$('#btnPlay').addEventListener('click', startGame);
$('#btnFlush').addEventListener('click', doFlush);
$('#btnNext').addEventListener('click', () => send({ t: 'nextwave' }));
$('#btnPause').addEventListener('click', () => send({ t: 'pause' }));
$('#btnReplayPause').addEventListener('click', () => send({ t: 'pause' }));
$('#btnMute').addEventListener('click', toggleMute);
$('#btnExit').addEventListener('click', showMenu);

// stream aim only while firing (the server logs a command only when something changed)
setInterval(() => {
  if (G.mode !== 'live' || !G.snap || G.snap.over) return;
  const x = Math.round(G.mouse.x / 4) * 4, y = Math.round(G.mouse.y / 4) * 4;
  const fire = G.firing && G.mouse.down;
  const key = fire ? `${x},${y},1` : '0';
  if (key === G.lastAim) return;
  G.lastAim = key;
  send({ t: 'aim', x, y, fire });
}, 50);

// ---------------------------------------------------------------------------- rendering
let bg = null;
function makeBackground() {
  bg = document.createElement('canvas');
  bg.width = 1920; bg.height = 1200;
  const c = bg.getContext('2d');
  c.scale(2, 2);
  const g = c.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, 640);
  g.addColorStop(0, '#0b1a30'); g.addColorStop(1, '#040810');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.strokeStyle = 'rgba(61,224,255,.06)'; c.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let y = 0; y <= H; y += 40) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  // decorative "circuit" traces
  c.strokeStyle = 'rgba(61,224,255,.07)'; c.lineWidth = 2;
  for (let i = 0; i < 26; i++) {
    let x = (i * 137) % W, y = (i * 89) % H;
    c.beginPath(); c.moveTo(x, y);
    for (let j = 0; j < 4; j++) { x += ((i + j) % 2 ? 40 : -40) * ((j % 3) + 1); y += ((i * j) % 2 ? 30 : -30); c.lineTo(x, y); }
    c.stroke();
    c.fillStyle = 'rgba(61,224,255,.12)'; c.beginPath(); c.arc(x, y, 3, 0, TAU); c.fill();
  }
}

function pathPoly() {
  const p = new Path2D();
  cfg.path.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])));
  return p;
}
let pathShape = null;

function drawPath(t) {
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = '#0a1830'; ctx.lineWidth = 44; ctx.stroke(pathShape);
  ctx.strokeStyle = '#102a48'; ctx.lineWidth = 36; ctx.stroke(pathShape);
  ctx.strokeStyle = '#08142a'; ctx.lineWidth = 28; ctx.stroke(pathShape);
  ctx.setLineDash([3, 20]); ctx.lineDashOffset = -t * 45;
  ctx.strokeStyle = 'rgba(61,224,255,.75)'; ctx.lineWidth = 2.5;
  ctx.shadowColor = '#3de0ff'; ctx.shadowBlur = 10;
  ctx.stroke(pathShape);
  ctx.restore();
}

function drawPortal(t) {
  ctx.save();
  ctx.translate(18, cfg.path[0][1]);
  for (let i = 0; i < 3; i++) {
    const a = (t * 1.2 + i * 0.33) % 1;
    ctx.strokeStyle = `rgba(255,138,61,${1 - a})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 8 + a * 22, 0, TAU); ctx.stroke();
  }
  ctx.fillStyle = '#ff8a3d'; ctx.font = '700 9px ui-monospace, monospace'; ctx.textAlign = 'center';
  ctx.fillText('INTERNET', 8, 42);
  ctx.restore();
}

function drawCore(t) {
  const [cx, cy] = cfg.path[cfg.path.length - 1];
  const hp = G.snap ? G.snap.core / 100 : 1;
  const col = hp > 0.6 ? '#4dff9a' : hp > 0.3 ? '#ffd84a' : '#ff4d6a';
  ctx.save();
  ctx.translate(cx, cy);
  const pulse = 1 + Math.sin(t * 3) * 0.05;
  ctx.shadowColor = col; ctx.shadowBlur = 24;
  ctx.strokeStyle = col; ctx.lineWidth = 3;
  for (const r of [34, 26]) { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + Math.PI / 6; ctx.lineTo(Math.cos(a) * r * pulse, Math.sin(a) * r * pulse); } ctx.closePath(); ctx.stroke(); }
  // database cylinder
  ctx.fillStyle = '#0c2236';
  ctx.beginPath(); ctx.ellipse(0, -8, 14, 5, 0, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-14, -8); ctx.lineTo(-14, 8); ctx.ellipse(0, 8, 14, 5, 0, Math.PI, 0, true); ctx.lineTo(14, -8); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(0, 0, 14, 5, 0, 0, Math.PI); ctx.stroke();
  ctx.shadowBlur = 0; ctx.fillStyle = col; ctx.font = '700 9px ui-monospace, monospace'; ctx.textAlign = 'center';
  ctx.fillText('CORE DB', 0, 52);
  ctx.restore();
}

function drawPads(t) {
  const occupied = new Set(G.snap ? G.snap.towers.map((x) => x[2]) : []);
  const hover = G.buildKind !== null && G.mouse.inside ? padAt(G.mouse.x, G.mouse.y) : -1;
  const affordable = G.snap && G.buildKind !== null && G.snap.credits >= cfg.towers[G.buildKind].cost;
  cfg.pads.forEach((p, i) => {
    if (occupied.has(i)) return;
    const active = G.buildKind !== null;
    ctx.save();
    ctx.translate(p[0], p[1]);
    ctx.strokeStyle = active ? (affordable ? `rgba(77,255,154,${0.55 + 0.25 * Math.sin(t * 5 + i)})` : 'rgba(255,77,106,.5)') : 'rgba(61,224,255,.25)';
    ctx.lineWidth = active ? 2 : 1.2;
    ctx.fillStyle = i === hover ? 'rgba(77,255,154,.22)' : 'rgba(10,24,44,.7)';
    ctx.beginPath(); ctx.roundRect(-17, -17, 34, 34, 7); ctx.fill(); ctx.stroke();
    ctx.restore();
    if (i === hover) drawRange(p[0], p[1], cfg.towers[G.buildKind].range, affordable ? '#4dff9a' : '#ff4d6a');
  });
}

function drawRange(x, y, r, color) {
  ctx.save();
  ctx.strokeStyle = color; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
  ctx.globalAlpha = 0.07; ctx.fillStyle = color; ctx.fill();
  ctx.restore();
}

function drawTower(tw, t) {
  const [id, kind, pad, level, angle, cd] = tw;
  const [x, y] = cfg.pads[pad];
  const col = TOWER_COLOR[kind];
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = col; ctx.shadowBlur = id === G.selId ? 22 : 10;
  ctx.strokeStyle = col; ctx.fillStyle = '#0a1628'; ctx.lineWidth = 2;

  if (kind === 0) { // firewall: brick tile + barrel
    ctx.beginPath(); ctx.roundRect(-15, -15, 30, 30, 5); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(-15, -5); ctx.lineTo(15, -5); ctx.moveTo(-15, 5); ctx.lineTo(15, 5); ctx.moveTo(0, -15); ctx.lineTo(0, -5); ctx.moveTo(-7, -5); ctx.lineTo(-7, 5); ctx.moveTo(7, -5); ctx.lineTo(7, 5); ctx.moveTo(0, 5); ctx.lineTo(0, 15); ctx.stroke();
    ctx.globalAlpha = 1; ctx.rotate(angle); ctx.fillStyle = col; ctx.fillRect(2, -3, 16 - cd * 4, 6);
  } else if (kind === 1) { // rate limiter: pulsing rings
    const range = cfg.towers[1].rangeByLevel[level - 1];
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, TAU); ctx.stroke();
    ctx.shadowBlur = 0;
    for (let i = 0; i < 2; i++) {
      const a = (t * 0.5 + i * 0.5) % 1;
      ctx.strokeStyle = `rgba(77,184,255,${0.35 * (1 - a)})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 12 + a * (range - 12), 0, TAU); ctx.stroke();
    }
  } else if (kind === 2) { // WAF: diamond + long rail
    ctx.rotate(Math.PI / 4); ctx.beginPath(); ctx.roundRect(-12, -12, 24, 24, 3); ctx.fill(); ctx.stroke(); ctx.rotate(-Math.PI / 4);
    ctx.rotate(angle); ctx.fillStyle = col; ctx.fillRect(0, -2, 24 - cd * 8, 4);
    ctx.fillStyle = '#fff'; ctx.fillRect(22 - cd * 8, -1, 3, 2);
  } else { // load balancer: spinning split arms
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.rotate(t * 0.8);
    for (let i = 0; i < 3; i++) { ctx.rotate(TAU / 3); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(11, 0); ctx.stroke(); ctx.beginPath(); ctx.arc(11, 0, 2.5, 0, TAU); ctx.fillStyle = col; ctx.fill(); }
    ctx.restore();
    ctx.rotate(angle); ctx.fillStyle = col; ctx.fillRect(4, -4, 14 - cd * 5, 8);
  }
  ctx.restore();

  // level pips
  ctx.fillStyle = col;
  for (let i = 0; i < level; i++) { ctx.beginPath(); ctx.arc(x - (level - 1) * 4 + i * 8, y + 24, 2.3, 0, TAU); ctx.fill(); }
}

const angleCache = new Map();
function drawEnemy(e, x, y, t) {
  const [id, kind, , , hp, slow] = e;
  const col = ENEMY_COLOR[kind];
  const r = cfg.enemies[kind].radius;
  const last = angleCache.get(id);
  let ang = last ? last.a : 0;
  if (last && (Math.abs(x - last.x) + Math.abs(y - last.y)) > 0.3) ang = Math.atan2(y - last.y, x - last.x);
  angleCache.set(id, { x, y, a: ang });

  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = col; ctx.shadowBlur = 12;
  ctx.fillStyle = col; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
  if (kind === 0) {
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-4, -r + 1); ctx.lineTo(-7, -r - 5); ctx.moveTo(4, -r + 1); ctx.lineTo(7, -r - 5); ctx.stroke();
    ctx.fillStyle = '#220a00'; ctx.beginPath(); ctx.arc(-3.5, -1, 2, 0, TAU); ctx.arc(3.5, -1, 2, 0, TAU); ctx.fill();
  } else if (kind === 1) {
    ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(r + 2, 0); ctx.lineTo(-r, -r * 0.8); ctx.lineTo(-r * 0.4, 0); ctx.lineTo(-r, r * 0.8); ctx.closePath(); ctx.fill();
  } else if (kind === 2) {
    ctx.rotate(Math.sin(t * 4 + id) * 0.2); ctx.beginPath(); ctx.roundRect(-r, -r, r * 2, r * 2, 3); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#1a0733'; ctx.font = '700 12px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText("';", 0, 4);
  } else if (kind === 3) {
    ctx.rotate(t * 8 + id);
    ctx.beginPath(); for (let i = 0; i < 8; i++) { const rr = i % 2 ? r * 0.4 : r * 1.4; const a = i / 8 * TAU; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); ctx.fill();
  } else if (kind === 4) {
    ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#2a0008'; ctx.fillRect(-5, -2, 10, 8);
    ctx.strokeStyle = '#2a0008'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, -2, 4, Math.PI, 0); ctx.stroke();
  } else {
    ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + Math.PI / 8; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#fff';
    for (let i = 0; i < 6; i++) { const a = t * 2 + i / 6 * TAU; ctx.beginPath(); ctx.arc(Math.cos(a) * (r + 7), Math.sin(a) * (r + 7), 2.5, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#2a0030'; ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, TAU); ctx.fill();
  }
  ctx.restore();

  if (slow) { ctx.save(); ctx.strokeStyle = 'rgba(77,184,255,.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 4, 0, TAU); ctx.stroke(); ctx.restore(); }
  if (hp < 0.999) {
    const w = Math.max(16, r * 2.2);
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x - w / 2, y - r - 10, w, 4);
    ctx.fillStyle = hp > 0.5 ? '#4dff9a' : hp > 0.25 ? '#ffd84a' : '#ff4d6a';
    ctx.fillRect(x - w / 2, y - r - 10, w * hp, 4);
  }
}

function drawOperator(t) {
  const [ox, oy] = [cfg.op.x, cfg.op.y];
  const m = G.mouse.inside ? G.mouse : { x: ox, y: oy - 100 };
  const ang = Math.atan2(m.y - oy, m.x - ox);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.shadowColor = '#3de0ff'; ctx.shadowBlur = 14;
  ctx.fillStyle = '#0a1c30'; ctx.strokeStyle = '#3de0ff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.rotate(ang);
  const recoil = G.firing && G.mouse.down ? (Math.sin(t * 60) + 1) * 1.2 : 0;
  ctx.fillStyle = '#3de0ff'; ctx.fillRect(4 - recoil, -4, 24, 8);
  ctx.fillStyle = '#fff'; ctx.fillRect(24 - recoil, -2, 4, 4);
  ctx.restore();
  ctx.fillStyle = '#3de0ff'; ctx.font = '700 9px ui-monospace, monospace'; ctx.textAlign = 'center';
  ctx.fillText('PATCH CANNON', ox, oy + 30);
}

function drawReticle(t) {
  if (!G.mouse.inside || G.mode !== 'live') return;
  const { x, y } = G.mouse;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = G.buildKind !== null ? '#4dff9a' : '#ffffff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9;
  ctx.rotate(t * 0.6);
  ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.stroke();
  for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(18, 0); ctx.stroke(); }
  ctx.restore();
  if (G.snap && G.snap.flush >= 1) {
    ctx.save(); ctx.strokeStyle = 'rgba(61,224,255,.25)'; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.arc(x, y, cfg.flushRadius, 0, TAU); ctx.stroke(); ctx.restore();
  }
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = now / 1000;
  if (cfg) draw(dt, t);
  requestAnimationFrame(frame);
}

function draw(dt, t) {
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.drawImage(bg, 0, 0, W, H);

  ctx.save();
  if (G.shake > 0.2) { ctx.translate((Math.random() - 0.5) * G.shake, (Math.random() - 0.5) * G.shake); G.shake *= 0.86; } else G.shake = 0;

  drawPath(t);
  drawPortal(t);
  drawCore(t);

  const snap = G.snap;
  if (snap) {
    drawPads(t);
    const sel = selectedTower();
    if (sel) { const p = cfg.pads[sel.pad]; drawRange(p[0], p[1], cfg.towers[sel.kind].rangeByLevel[sel.level - 1], TOWER_COLOR[sel.kind]); }
    for (const tw of snap.towers) drawTower(tw, t);

    // interpolate between the last two server snapshots
    const alpha = Math.min(1, (performance.now() - G.tRecv) / 34);
    const prevMap = new Map();
    if (G.prev) for (const e of G.prev.enemies) prevMap.set(e[0], e);
    const alive = new Set();
    for (const e of snap.enemies) {
      alive.add(e[0]);
      const p = prevMap.get(e[0]);
      const x = p ? p[2] + (e[2] - p[2]) * alpha : e[2];
      const y = p ? p[3] + (e[3] - p[3]) * alpha : e[3];
      drawEnemy(e, x, y, t);
    }
    for (const k of angleCache.keys()) if (!alive.has(k)) angleCache.delete(k);

    ctx.save();
    ctx.shadowColor = '#3de0ff'; ctx.shadowBlur = 10; ctx.fillStyle = '#c9f6ff';
    for (const s of snap.shots) { ctx.beginPath(); ctx.arc(s[1], s[2], 3, 0, TAU); ctx.fill(); }
    ctx.restore();
  }

  // effects
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const b of G.beams) {
    const a = b.life / b.max;
    ctx.globalAlpha = a; ctx.strokeStyle = b.color; ctx.lineWidth = b.w; ctx.shadowColor = b.color; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
    b.life -= dt;
  }
  for (const r of G.rings) {
    const k = 1 - r.life / r.max;
    ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = r.color; ctx.lineWidth = r.thick ? 5 : 2;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r * (0.2 + k * 0.8), 0, TAU); ctx.stroke();
    r.life -= dt;
  }
  for (const p of G.parts) {
    ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; p.life -= dt;
  }
  ctx.restore();
  G.beams = G.beams.filter((b) => b.life > 0);
  G.rings = G.rings.filter((r) => r.life > 0);
  G.parts = G.parts.filter((p) => p.life > 0);
  if (G.parts.length > 600) G.parts.splice(0, G.parts.length - 600);

  ctx.font = '700 12px ui-monospace, monospace'; ctx.textAlign = 'center';
  for (const f of G.floats) {
    ctx.globalAlpha = Math.max(0, f.life / f.max); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y - (1 - f.life / f.max) * 22);
    f.life -= dt;
  }
  ctx.globalAlpha = 1;
  G.floats = G.floats.filter((f) => f.life > 0);

  if (G.mode !== 'menu') drawOperator(t);
  drawReticle(t);
  ctx.restore();

  if (G.flash > 0.01) { ctx.fillStyle = `rgba(255,40,70,${G.flash * 0.5})`; ctx.fillRect(0, 0, W, H); G.flash *= 0.9; }

  if (G.banner) {
    const b = G.banner; b.t += dt;
    const a = b.t < 0.3 ? b.t / 0.3 : b.t > 1.8 ? Math.max(0, 1 - (b.t - 1.8) / 0.6) : 1;
    if (b.t > 2.4) G.banner = null;
    else {
      ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'center';
      ctx.shadowColor = b.boss ? '#ff2bd6' : b.good ? '#4dff9a' : '#3de0ff'; ctx.shadowBlur = 24;
      ctx.fillStyle = b.boss ? '#ff7be8' : b.good ? '#4dff9a' : '#c9f6ff';
      ctx.font = '900 44px system-ui, sans-serif'; ctx.fillText(b.text, W / 2, 250);
      ctx.font = '700 14px ui-monospace, monospace'; ctx.fillText(b.sub, W / 2, 278);
      ctx.restore();
    }
  }

  if (G.snap && G.snap.paused) {
    ctx.fillStyle = 'rgba(2,6,12,.55)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.font = '900 38px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('PAUSED', W / 2, H / 2);
  }
}

// ---------------------------------------------------------------------------- boot
(async function boot() {
  try {
    cfg = await (await fetch('/api/config')).json();
  } catch {
    document.body.textContent = 'Could not reach the game server.';
    return;
  }
  try { $('#inName').value = localStorage.getItem('psName') || ''; } catch { /* ignore */ }
  pathShape = pathPoly();
  makeBackground();
  buildShop();
  loadBoard();
  requestAnimationFrame(frame);
})();
