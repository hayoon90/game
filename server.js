// 셀 먹기 IO - 게임 서버
// 게임 세계(먹이, 봇, 바이러스, 모든 셀)를 서버가 한 곳에서 계산하고,
// 브라우저는 입력만 보내고 상태를 받아 그립니다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const S = 3000;            // 맵 크기
const FOODN = 450;         // 먹이 수
const VIRN = 12;           // 바이러스 수
const BOTN = 12;           // 봇 수
const MAXP = 60;           // 동시 접속 상한
const TICK = 1000 / 30;    // 30Hz 시뮬레이션

const rad = m => Math.sqrt(m) * 3.2;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a = 0, b = S) => Math.max(a, Math.min(b, v));
const COLS = ['#ff6b6b', '#feca57', '#48dbfb', '#1dd1a1', '#a29bfe', '#ff9ff3', '#fd9644'];
const BNAMES = ['모찌', '콩이', '하늘', '번개', '도토리', '별똥', '라떼', '호랑', '바람', '구름', '젤리', '쭈니', '나무', '불꽃'];
const pickCol = () => COLS[(Math.random() * COLS.length) | 0];

// ---------- HTTP (게임 화면 + 상태 확인) ----------
const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(INDEX));
  }
  res.writeHead(404); res.end('not found');
});

// ---------- 게임 세계 ----------
let nid = 1, pid = 1, gt = 0;
let cells = [], foods = [], vs = [], ej = [], fch = [];
const players = new Map();

function mkCell(o) {
  return { id: nid++, o: o || 0, x: rnd(100, S - 100), y: rnd(100, S - 100), m: 20, c: pickCol(), n: '',
    a: rnd(0, 6.28), t: 0, ix: 0, iy: 0, mt: 0, pr: 0, bot: 0, bi: 0, dead: 0 };
}
function mkBot(i) {
  const c = mkCell(0);
  c.bot = 1; c.bi = i; c.m = rnd(15, 120); c.n = BNAMES[i % BNAMES.length];
  return c;
}
function newFood(i) {
  const f = { x: Math.round(rnd(0, S)), y: Math.round(rnd(0, S)), c: pickCol() };
  foods[i] = f;
  return f;
}
for (let i = 0; i < FOODN; i++) newFood(i);
for (let i = 0; i < VIRN; i++) vs.push({ x: rnd(200, S - 200), y: rnd(200, S - 200), m: 100, t: 0 });
for (let i = 0; i < BOTN; i++) cells.push(mkBot(i));

function spawnPos() {
  let best = { x: S / 2, y: S / 2 }, bd = -1;
  for (let i = 0; i < 8; i++) {
    const x = rnd(300, S - 300), y = rnd(300, S - 300);
    let md = 1e9;
    for (const c of cells) { const d = Math.hypot(c.x - x, c.y - y) - rad(c.m); if (d < md) md = d; }
    if (md > bd) { bd = md; best = { x, y }; }
  }
  return best;
}

function send(p, obj) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }

function join(p, name, color) {
  if (p.alive) return;
  const c = mkCell(p.id), sp = spawnPos();
  c.x = sp.x; c.y = sp.y; c.n = name; c.c = color; c.pr = gt + 3;
  cells.push(c);
  Object.assign(p, { alive: true, name, color, tx: c.x, ty: c.y, z: 1, score: 20, boost: 0, sT: 0, eT: 0 });
}

function kill(b, by) {
  if (b.dead) return;
  b.dead = 1;
  if (b.o) {
    const p = players.get(b.o);
    if (p && !cells.some(c => c.o === b.o && !c.dead)) {
      p.alive = false;
      send(p, { t: 'dead', by: by ? by.n : '', score: p.score });
    }
  } else {
    cells.push(mkBot(b.bi));
  }
}

function doSplit(p) {
  if (!p.alive || gt < p.sT) return;
  p.sT = gt + 0.15;
  const mine = cells.filter(c => c.o === p.id && !c.dead);
  let n = mine.length;
  for (const c of mine) {
    if (n >= 8) break;
    if (c.m < 40) continue;
    c.m /= 2; c.mt = gt + 12;
    const dx = p.tx - c.x, dy = p.ty - c.y, d = Math.hypot(dx, dy) || 1;
    const q = mkCell(p.id);
    Object.assign(q, { x: c.x, y: c.y, m: c.m, c: c.c, n: c.n, mt: gt + 12, ix: dx / d * 700, iy: dy / d * 700 });
    cells.push(q); n++;
  }
}

function doEject(p) {
  if (!p.alive || gt < p.eT) return;
  p.eT = gt + 0.12;
  for (const c of cells) {
    if (c.o !== p.id || c.dead || c.m < 35) continue;
    c.m -= 8;
    const dx = p.tx - c.x, dy = p.ty - c.y, d = Math.hypot(dx, dy) || 1, r = rad(c.m);
    ej.push({ x: c.x + dx / d * r, y: c.y + dy / d * r, vx: dx / d * 620, vy: dy / d * 620,
      a: Math.atan2(dy, dx), m: 8, c: c.c, t: gt + 0.35 });
  }
  if (ej.length > 300) ej.splice(0, ej.length - 300);
}

function aiPick(c) {
  let bt = null, bd = 1e9, mode = 0;
  for (const o of cells) {
    if (o === c || o.dead) continue;
    const d = Math.hypot(o.x - c.x, o.y - c.y);
    if (o.m > c.m && d < 350 + rad(o.m) && d < bd) { bt = o; bd = d; mode = -1; }
  }
  if (!bt) for (const o of cells) {
    if (o === c || o.dead || gt < o.pr) continue;
    const d = Math.hypot(o.x - c.x, o.y - c.y);
    if (c.m > o.m && d < 450 && d < bd) { bt = o; bd = d; mode = 1; }
  }
  if (!bt) for (const f of foods) {
    const d = Math.hypot(f.x - c.x, f.y - c.y);
    if (d < 260 && d < bd) { bt = f; bd = d; mode = 2; }
  }
  for (const v of vs) {
    if (gt >= v.t && c.m > v.m * 1.1 && Math.hypot(v.x - c.x, v.y - c.y) < rad(c.m) + 120) { bt = v; mode = -1; break; }
  }
  if (bt) c.a = Math.atan2(bt.y - c.y, bt.x - c.x) + (mode < 0 ? Math.PI : 0);
  else c.a += rnd(-1, 1);
}

function tick(dt) {
  gt += dt;
  // 이동, 먹이 먹기, 질량 감소
  for (const c of cells) {
    if (c.dead) continue;
    let dx = 0, dy = 0, sp = 540 * Math.pow(c.m, -0.3);
    if (c.o) {
      const p = players.get(c.o);
      if (!p) { c.dead = 1; continue; }
      const wx = p.tx - c.x, wy = p.ty - c.y, d = Math.hypot(wx, wy);
      if (d * p.z > 8) { dx = wx / d; dy = wy / d; sp *= Math.min(1, d * p.z / 80); } else sp = 0;
      if (p.boost && c.m > 25) { sp *= 1.8; c.m -= c.m * 0.05 * dt; }
    } else {
      c.t -= dt;
      if (c.t <= 0) { c.t = rnd(0.2, 0.5); aiPick(c); }
      dx = Math.cos(c.a); dy = Math.sin(c.a);
    }
    c.x = clamp(c.x + (dx * sp + c.ix) * dt);
    c.y = clamp(c.y + (dy * sp + c.iy) * dt);
    if (c.ix || c.iy) { const f = Math.max(0, 1 - 5 * dt); c.ix *= f; c.iy *= f; }
    if (!c.o && (c.x <= 0 || c.x >= S || c.y <= 0 || c.y >= S)) c.a = Math.atan2(S / 2 - c.y, S / 2 - c.x);
    const r = rad(c.m);
    for (let i = 0; i < FOODN; i++) {
      const f = foods[i];
      if ((f.x - c.x) ** 2 + (f.y - c.y) ** 2 < r * r) {
        c.m += 1;
        const nf = newFood(i);
        fch.push([i, nf.x, nf.y, nf.c]);
      }
    }
    c.m = Math.max(10, c.m - c.m * 0.002 * dt);
  }

  // 셀끼리 먹기 (조금이라도 크면 먹을 수 있음)
  const snap = cells.slice();
  for (const a of snap) for (const b of snap) {
    if (a === b || a.dead || b.dead || (a.o && a.o === b.o) || gt < b.pr) continue;
    if (a.m > b.m && Math.hypot(a.x - b.x, a.y - b.y) < rad(a.m) - rad(b.m) * 0.4) {
      a.m += b.m * 0.8;
      kill(b, a);
    }
  }

  // 바이러스
  for (const v of vs) {
    if (gt < v.t) continue;
    for (const c of cells) {
      if (c.dead || c.m <= v.m * 1.1 || Math.hypot(c.x - v.x, c.y - v.y) >= rad(c.m) - rad(v.m) * 0.4) continue;
      const vm = v.m;
      v.t = gt + 8; v.m = 100;
      if (c.o) {
        c.m += vm * 0.5;
        const n = cells.filter(q => q.o === c.o && !q.dead).length, ex = Math.min(5, 8 - n);
        if (ex > 0) {
          c.m /= ex + 1; c.mt = gt + 12;
          for (let i = 0; i < ex; i++) {
            const a = Math.random() * 6.283, q = mkCell(c.o);
            Object.assign(q, { x: c.x, y: c.y, m: c.m, c: c.c, n: c.n, mt: gt + 12, ix: Math.cos(a) * 650, iy: Math.sin(a) * 650 });
            cells.push(q);
          }
        }
      } else c.m *= 0.55;
      break;
    }
  }

  // 던진 질량
  for (let i = ej.length - 1; i >= 0; i--) {
    const e = ej[i];
    e.x = clamp(e.x + e.vx * dt); e.y = clamp(e.y + e.vy * dt);
    const fr = Math.max(0, 1 - 4 * dt); e.vx *= fr; e.vy *= fr;
    let gone = 0;
    for (const v of vs) {
      if (gt >= v.t && Math.hypot(e.x - v.x, e.y - v.y) < rad(v.m)) {
        gone = 1; v.m += e.m;
        if (v.m >= 150 && vs.length < 20) {
          v.m = 100;
          vs.push({ x: clamp(v.x + Math.cos(e.a) * 150, 50, S - 50), y: clamp(v.y + Math.sin(e.a) * 150, 50, S - 50), m: 100, t: 0 });
        }
        break;
      }
    }
    if (!gone && gt > e.t) for (const c of cells) {
      if (!c.dead && Math.hypot(e.x - c.x, e.y - c.y) < rad(c.m)) { c.m += e.m; gone = 1; break; }
    }
    if (gone) ej.splice(i, 1);
  }

  // 같은 사람의 조각: 밀어내기 / 합치기 / 점수
  for (const p of players.values()) {
    if (!p.alive) continue;
    const mine = cells.filter(c => c.o === p.id && !c.dead);
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i], b = mine[j];
      if (a.dead || b.dead) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, ra = rad(a.m), rb = rad(b.m);
      if (gt > a.mt && gt > b.mt) {
        if (d < Math.max(ra, rb)) {
          const big = a.m >= b.m ? a : b, sm = big === a ? b : a;
          big.m += sm.m; sm.dead = 1;
        }
      } else if (d < ra + rb) {
        const o = (ra + rb - d) * 0.25, nx = (a.x - b.x) / d, ny = (a.y - b.y) / d;
        a.x += nx * o; a.y += ny * o; b.x -= nx * o; b.y -= ny * o;
      }
    }
    let sum = 0;
    for (const c of mine) if (!c.dead) sum += c.m;
    p.score = Math.floor(sum);
  }

  cells = cells.filter(c => !c.dead);
}

// ---------- 상태 전송 ----------
function lbData() {
  const tot = new Map();
  for (const c of cells) {
    const k = c.o || 'b' + c.id;
    const t = tot.get(k) || { n: c.n, m: 0, o: c.o };
    t.m += c.m; tot.set(k, t);
  }
  return [...tot.values()].sort((a, b) => b.m - a.m).slice(0, 5).map(t => [t.n, Math.floor(t.m), t.o]);
}

let tk = 0;
function broadcast() {
  const msg = {
    t: 's',
    c: cells.map(c => [c.id, c.o, Math.round(c.x), Math.round(c.y), Math.round(c.m), c.c, c.n, gt < c.pr ? 1 : 0]),
    v: vs.filter(v => gt >= v.t).map(v => [Math.round(v.x), Math.round(v.y), Math.round(v.m)]),
    e: ej.map(e => [Math.round(e.x), Math.round(e.y), e.m, e.c]),
    f: fch
  };
  fch = [];
  if (tk % 15 === 0) { msg.lb = lbData(); msg.np = players.size; }
  const s = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.ws.readyState === 1 && p.ws.bufferedAmount < 1e6) p.ws.send(s);
  }
}

let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (players.size === 0) return;   // 접속자가 없으면 세계를 멈춤
  tick(dt);
  tk++;
  if (players.size <= 15 || tk % 2 === 0) broadcast();
}, TICK);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 512 });
const cleanName = n => String(n || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f\ufeff]/g, '').trim().slice(0, 10) || '나';
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

wss.on('connection', ws => {
  if (players.size >= MAXP) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
  const p = { id: pid++, ws, alive: false, name: '', color: pickCol(), tx: S / 2, ty: S / 2, z: 1, boost: 0, score: 0, mc: 0, sT: 0, eT: 0 };
  players.set(p.id, p);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(p, { t: 'init', id: p.id, S, foods: foods.map(f => [f.x, f.y, f.c]) });

  ws.on('message', (buf, isBin) => {
    if (isBin || ++p.mc > 150) return;
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'join': {
        const color = COLS.includes(m.color) ? m.color : pickCol();
        if (players.size > MAXP) return;
        join(p, cleanName(m.name), color);
        break;
      }
      case 'in':
        p.tx = clamp(num(m.x, p.tx)); p.ty = clamp(num(m.y, p.ty)); p.z = clamp(num(m.z, 1), 0.2, 1.5);
        break;
      case 'split': doSplit(p); break;
      case 'eject': doEject(p); break;
      case 'boost': p.boost = m.v ? 1 : 0; break;
    }
  });

  ws.on('close', () => {
    for (const c of cells) if (c.o === p.id) c.dead = 1;
    players.delete(p.id);
  });
  ws.on('error', () => {});
});

setInterval(() => { for (const p of players.values()) p.mc = 0; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log('셀 먹기 IO 서버 실행 중: 포트 ' + PORT));
