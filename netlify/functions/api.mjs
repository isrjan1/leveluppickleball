// Pickleball Level Up v6 API: server-authoritative XP, Elo, queue, coach sign-off, RBAC.
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, randomBytes, timingSafeEqual, scrypt } from "node:crypto";
const scr = (p, salt) => new Promise((res, rej) => scrypt(p, salt, 32, (e, k) => (e ? rej(e) : res(k))));

const NAME = /^[A-Za-z0-9_.-]{3,20}$/, ID = /^[a-z0-9]{1,16}$/, TOK = /^[A-Za-z0-9_.-]{1,64}$/;
const J = (o, s = 200) => Response.json(o, { status: s, headers: { "cache-control": "no-store" } });
const FRESH = 45 * 6e4, fresh = x => Date.now() - x.t < FRESH; // queue entries expire after 45 min
const E = (m, s = 400) => J({ error: m }, s);
const sign = (k, t) => createHmac("sha256", k).update(t).digest("base64url");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const uid = () => randomBytes(5).toString("hex");
const TIERS = ["Beginner", "Intermediate", "Advanced"];
const BADGES = { dink_master: { n: "Dink Master", tier: 1 }, third_shot_pro: { n: "Third-Shot Drop Pro", tier: 2 } };
const POOL = [["Wall dinks: 50 in a row", 15], ["Paddle flips: 3 sets of 20", 10], ["Footwork shadow drill: 5 min", 15],
  ["Soft-hands catch drill: 3 min", 10], ["Serve target practice: 20 serves", 15], ["Split-step shadow rallies: 5 min", 10],
  ["Backhand wall volleys: 3 sets of 15", 15], ["Lateral kitchen-line shuffles: 4 x 30 sec", 10], ["Drop-shot toss-and-catch: 30 reps", 10],
  ["Return-of-serve shadow swings: 30 reps", 10]];
const ROLE = ["player", "certified_coach", "admin"];
const RESERVED = new Set(["admin", "administrator", "root", "system", "support", "staff"]); // can't be registered by the public
const MIX_AFTER = 10 * 6e4; // after this long without 4 in their own tier, players may be matched with the adjacent tier
// Tier ceiling: Elo and XP stop growing until the next badge is signed off by a coach.
const DAILY = 150; // max XP per day from ranked matches
const CAP = [{ elo: 1200, xp: 1000 }, { elo: 1400, xp: 3000 }, { elo: Infinity, xp: Infinity }];
const DEF = { courts: ["Court 1", "Court 2", "Court 3", "Court 4"], lat: null, lng: null, rad: 150, minMin: 5, tz: "UTC", qr: false, inv: [] };

const jget = async (s, k, d) => (await s.get(k, { type: "json" })) ?? d;
const getU = (s, id) => jget(s, "u/" + id, null);
// Cap a log at max entries, dropping the oldest records that are no longer live first (keep(x) = still live).
const trim = (arr, max, keep) => {
  for (let i = 0; i < arr.length && arr.length > max;) keep(arr[i]) ? i++ : arr.splice(i, 1);
  if (arr.length > max) arr.splice(0, arr.length - max);
};
// ---- Concurrency: optimistic compare-and-swap with retry (Netlify Blobs conditional writes) ----
class Bad extends Error { constructor(m, st = 400) { super(m); this.st = st; } }
const SKIP = Symbol("skip");
let warned = false;
// Read key (strong) -> fn(data) edits in place or returns new data (or SKIP) -> write only if nobody changed it meanwhile; else retry.
async function mutate(s, key, def, fn) {
  for (let i = 0; i < 8; i++) {
    const r = await s.getWithMetadata(key, { type: "json", consistency: "strong" });
    const data = r ? r.data : structuredClone(def);
    const nd = await fn(data);
    if (nd === SKIP) return;
    const w = await s.setJSON(key, nd === undefined ? data : nd, r ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (w && w.modified === false) { await new Promise(x => setTimeout(x, 10 + Math.random() * 40 * (i + 1))); continue; }
    if (!w && !warned) { warned = true; console.warn("@netlify/blobs does not report conditional writes: upgrade the package"); }
    return;
  }
  throw new Bad("Server busy, please try again", 503);
}
const mutU = (s, id, fn) => mutate(s, "u/" + id, null, u => { if (!u) throw new Bad("User not found", 404); return fn(u); });
const giveXp = (s, id, n) => mutate(s, "u/" + id, null, u => { if (!u) return SKIP; addXp(u, n); });
async function createUser(s, u) { // username claimed atomically
  await s.setJSON("u/" + u.id, u);
  const r = await s.set("name/" + u.username.toLowerCase(), u.id, { onlyIfNew: true });
  if (r && r.modified === false) { await s.delete("u/" + u.id); return false; }
  return true;
}
async function loadAll(s) {
  const { blobs } = await s.list({ prefix: "u/" });
  return (await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })))).filter(Boolean);
}
const strip = ({ ph, salt, h, tv, dx, ...u }) => u;
const tierOf = u => (u.badges.includes("dink_master") ? (u.badges.includes("third_shot_pro") ? 2 : 1) : 0);
// XP past the tier ceiling is banked (max 500) and released when the next badge is signed off.
const addXp = (u, n) => { const g = Math.min(n, Math.max(0, CAP[tierOf(u)].xp - u.xp)); u.xp += g; if (g < n) u.bank = Math.min(500, (u.bank | 0) + n - g); };
const pub = u => ({ ...strip(u), tier: tierOf(u), cap: tierOf(u) < 2 ? CAP[tierOf(u)] : null });
const newUser = (n, role = "player") => ({ id: uid(), username: n, role, created: Date.now(), disabled: false, tv: 0,
  defaultPw: false, xp: 0, elo: 1000, badges: [], w: 0, l: 0, done: [], ci: 0, last: "" });
async function setPw(u, pw) { u.salt = randomBytes(16).toString("hex"); u.h = (await scr(pw, u.salt)).toString("hex"); delete u.ph; }

let SEC; // signing secret never changes once created, so cache it per function instance
async function secret(s) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (SEC) return SEC;
  let k = await s.get("secret");
  if (!k) { // first-ever requests may race: only one candidate wins, everyone re-reads the winner
    const n = randomBytes(32).toString("hex"), r = await s.set("secret", n, { onlyIfNew: true });
    k = r && r.modified === false ? await s.get("secret") : n;
  }
  return (SEC = k);
}
async function byName(s, n) {
  if (!NAME.test(n || "")) return null;
  const id = await s.get("name/" + n.toLowerCase());
  return id ? getU(s, id) : null;
}
let BOOTED = false;
async function boot(s) {
  if (BOOTED) return;
  if (await byName(s, "admin")) return (BOOTED = true);
  if ((await loadAll(s)).some(x => x.role === "admin" && !x.disabled)) return (BOOTED = true);
  // Never fall back to a guessable password: a fresh public deploy would hand admin to whoever logs in first.
  if (!process.env.ADMIN_PASSWORD) { console.warn("No admin account yet: set ADMIN_PASSWORD in Netlify env vars and redeploy"); return; }
  const u = newUser("admin", "admin");
  await setPw(u, process.env.ADMIN_PASSWORD);
  await createUser(s, u); BOOTED = true;
}
async function auth(s, req) {
  const [id, exp, tv, sig] = (req.headers.get("authorization") || "").replace("Bearer ", "").split(".");
  if (!sig || !ID.test(id) || Date.now() > +exp) return null;
  if (!same(sig, sign(await secret(s), id + "." + exp + "." + tv))) return null;
  const u = await getU(s, id);
  return u && !u.disabled && String(u.tv | 0) === tv ? u : null;
}
async function token(s, u) {
  const p = u.id + "." + (Date.now() + 30 * 864e5) + "." + (u.tv | 0);
  return p + "." + sign(await secret(s), p);
}
async function verify(s, u, pw) {
  if (!u) { await scr(pw, "x".repeat(32)); return false; }
  if (u.h) return same((await scr(pw, u.salt)).toString("hex"), u.h);
  if (u.ph && same(createHash("sha256").update(u.salt + ":" + pw).digest("hex"), u.ph)) { await mutU(s, u.id, x => setPw(x, pw)); return true; } // upgrade legacy hash
  return false;
}
const rk = k => "rl/" + createHash("sha1").update(k).digest("hex");
async function locked(s, k, max, win) { const r = await jget(s, rk(k), null); return !!r && Date.now() - r.t < win && r.n >= max; }
const hit = (s, k, win) => mutate(s, rk(k), null, r => { const f = r && Date.now() - r.t < win; return { n: f ? r.n + 1 : 1, t: f ? r.t : Date.now() }; });
const dist = (a, b, c, d) => {
  const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
};
const qrAt = async (s, w) => sign(await secret(s), "qr:" + w).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
const qrOk = async (s, c) => { const w = Math.floor(Date.now() / 6e4); c = c.trim().toUpperCase(); for (let i = 0; i < 3; i++) if (same(await qrAt(s, w - i), c)) return true; return false; };
const dayN = tz => { try { return Math.floor(Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now())) + "T00:00:00Z") / 864e5); } catch { return Math.floor(Date.now() / 864e5); } };
// Three distinct drills per day, picked by a day-seeded shuffle so the mix changes daily (same for everyone in the club).
const todays = tz => {
  const d = dayN(tz), idx = POOL.map((_, i) => i);
  let r = (d * 2654435761) >>> 0;
  for (let i = idx.length - 1; i > 0; i--) { r = (Math.imul(r ^ (r >>> 15), 2246822507) + 0x6d2b79f5) >>> 0; const j = r % (i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, 3).map(k => ({ id: "d" + d + "-" + k, t: POOL[k][0], xp: POOL[k][1] }));
};

// Elo-style XP engine. Ex = expected win chance. Underdog upset 2.5x XP, stomping 0.25x, losing underdogs protected, losing favorites penalized.
// planFinish runs inside the match CAS (reads only); the winner of that CAS applies the result to each player with a per-user CAS, so XP is applied exactly once.
async function planFinish(s, m, sa, sb, ms, tz) {
  const us = await Promise.all(m.p.map(id => getU(s, id)));
  if (us.some(u => !u)) { m.status = "done"; m.void = true; m.end = Date.now(); return null; }
  const ea = (us[0].elo + us[1].elo) / 2, eb = (us[2].elo + us[3].elo) / 2;
  const EA = 1 / (1 + 10 ** ((eb - ea) / 400)), aw = sa > sb;
  // repeat-group damping: same group (3+ shared players) finishing again within 12h earns less XP
  const rep = ms.filter(x => x !== m && x.status === "done" && !x.void && Date.now() - x.end < 432e5 && x.p.filter(id => m.p.includes(id)).length >= 3).length;
  if (rep >= 2) m.flag = true;
  m.status = "done"; m.sa = sa; m.sb = sb; m.end = Date.now();
  return { tz, sa, sb, rm: rep >= 2 ? .25 : rep >= 1 ? .5 : 1, ids: m.p.slice(), p: us.map((_, i) => { const A = i < 2; return { A, win: A === aw, Ex: A ? EA : 1 - EA }; }) };
}
function applyResult(u, pl, { A, win, Ex }) {
  const dn = dayN(pl.tz);
  let d = 32 * ((win ? 1 : 0) - Ex), xp = 10;
  if (win) xp = Math.round(30 * (Ex < .4 ? 2.5 : Ex > .7 ? .25 : 1));
  else { if (Ex < .4) d *= .4; if (Ex > .6) d *= 1.5; }
  d = Math.round(d);
  const raw = xp; xp = Math.round(xp * pl.rm);
  if (!u.dx || u.dx.d !== dn) u.dx = { d: dn, n: 0 };
  xp = Math.max(0, Math.min(xp, DAILY - u.dx.n)); u.dx.n += xp;
  const cut = xp < raw, x0 = u.xp, e0 = u.elo;
  u.elo = Math.min(CAP[tierOf(u)].elo, Math.max(100, u.elo + d)); addXp(u, xp); win ? u.w++ : u.l++;
  const gx = u.xp - x0, ge = u.elo - e0;
  u.last = `${win ? "Won" : "Lost"} ${A ? pl.sa : pl.sb}-${A ? pl.sb : pl.sa}: ${gx} XP, Elo ${ge >= 0 ? "+" : ""}${ge}` + (gx < xp || (d > 0 && ge < d) ? " (tier ceiling)" : "") + (cut ? " (reduced: daily cap or repeat group)" : "");
}
async function applyPlan(s, pl) {
  if (!pl) return;
  const r = await Promise.allSettled(pl.ids.map((id, i) => mutU(s, id, u => applyResult(u, pl, pl.p[i]))));
  r.forEach(x => x.status === "rejected" && console.error("applyPlan", x.reason));
}
async function expire(s) {
  await mutate(s, "m", [], ms => {
    let ch = false;
    for (const m of ms) if ((m.status === "playing" && Date.now() - m.start > 3 * 36e5) || (m.status === "disputed" && Date.now() - m.start > 12 * 36e5)) { m.status = "done"; m.void = true; m.end = Date.now(); ch = true; }
    return ch ? undefined : SKIP;
  });
}
// Matches are created inside the "m" CAS (court + player exclusivity can't be violated), then used players leave the queue.
async function matchmake(s, cfg) {
  await expire(s);
  const used = new Set();
  await mutate(s, "m", [], async ms => {
    used.clear();
    const q = (await jget(s, "q", [])).filter(fresh), act = ms.filter(m => m.status !== "done");
    const busy = new Set(act.map(m => m.court)), inM = new Set(act.flatMap(m => m.p));
    let ch = false;
    const avail = x => !inM.has(x.id);
    const start = async (t, four, mixed) => {
      const free = cfg.courts.find(c => !busy.has(c));
      if (!free) return false;
      const us = await Promise.all(four.map(x => getU(s, x.id)));
      const bad = four.filter((_, i) => !us[i] || us[i].disabled);
      if (bad.length) { bad.forEach(f => { inM.add(f.id); used.add(f.id); }); return true; } // drop dead entries from the queue, keep going
      us.sort((a, b) => b.elo - a.elo); // strongest + weakest vs the middle two
      ms.push({ id: uid(), court: free, tier: t, mixed: mixed || undefined, p: [us[0].id, us[3].id, us[1].id, us[2].id], start: Date.now(), status: "playing", sub: {} });
      busy.add(free); four.forEach(f => { inM.add(f.id); used.add(f.id); }); ch = true;
      return true;
    };
    // Pass 1: same-tier matches, as many as there are free courts (oldest in queue first).
    for (let t = 0; t < 3; t++) {
      for (let row; (row = q.filter(x => x.tier === t && avail(x))).length >= 4;) if (!(await start(t, row.slice(0, 4)))) break;
    }
    // Pass 2: a tier that can't fill a court and has waited MIX_AFTER may borrow from the adjacent tier(s).
    for (let t = 0; t < 3; t++) {
      for (let row; (row = q.filter(x => x.tier === t && avail(x))).length && Date.now() - row[0].t >= MIX_AFTER;) {
        const pool = [t + 1, t - 1].map(nb => row.concat(q.filter(x => x.tier === nb && avail(x)))).find(p => p.length >= 4); // one neighbour tier only
        if (!pool || !(await start(t, pool.slice(0, 4), true))) break;
      }
    }
    for (let i = 0; i < ms.length && ms.length > 300;) ms[i].status === "done" ? ms.splice(i, 1) : i++;
    return ch ? undefined : SKIP;
  });
  if (used.size) await mutate(s, "q", [], q => q.filter(x => fresh(x) && !used.has(x.id)));
}

async function board(s) {
  const c = await jget(s, "board", null);
  if (c && Date.now() - c.t < 6e4) return c.rows;
  const rows = (await loadAll(s)).filter(u => u.role !== "admin" && !u.disabled).sort((a, b) => b.elo - a.elo).slice(0, 25)
    .map(u => ({ id: u.id, n: u.username, e: u.elo, x: u.xp, t: tierOf(u) }));
  await s.setJSON("board", { t: Date.now(), rows });
  return rows;
}
async function coaches(s, force) {
  let c = force ? null : await jget(s, "coaches", null);
  if (!c) { c = (await loadAll(s)).filter(u => u.role === "certified_coach" && !u.disabled).map(u => ({ id: u.id, n: u.username, pay: u.pay || "" })); await s.setJSON("coaches", c); }
  return c;
}
async function snapshot(s, me, cfg, full) {
  const names = new Map(), nm = id => { if (!names.has(id)) names.set(id, getU(s, id).then(u => u?.username || "?")); return names.get(id); };
  const [ms, q, bk, hw, co, bd, ss] = await Promise.all([jget(s, "m", []), jget(s, "q", []), jget(s, "bk", []), jget(s, "hw", []), coaches(s), board(s), jget(s, "ss", [])]);
  const qf = q.filter(fresh), live = bk.filter(b => b.status !== "cancelled"), sm = new Map(ss.map(x => [x.id, x])), cn = new Map(co.map(c => [c.id, c.n])), cp = new Map(co.map(c => [c.id, c.pay]));
  const mm = ms.filter(m => m.p.includes(me.id) && m.status !== "done" && Date.now() - m.start < 3 * 36e5).pop();
  const out = {
    me: pub(me), qr: !!cfg.qr, tiers: TIERS, badgeDefs: BADGES, today: todays(cfg.tz).map(x => ({ ...x, done: me.done.includes(x.id) })),
    checked: Date.now() - me.ci < 4 * 36e5, inQueue: qf.some(x => x.id === me.id), qSince: qf.find(x => x.id === me.id)?.t || null, mixAfter: MIX_AFTER,
    queue: TIERS.map((_, t) => qf.filter(x => x.tier === t).length),
    match: mm ? { id: mm.id, court: mm.court, status: mm.status, start: mm.start, minMin: cfg.minMin, mixed: !!mm.mixed,
      A: [await nm(mm.p[0]), await nm(mm.p[1])], B: [await nm(mm.p[2]), await nm(mm.p[3])], sent: !!mm.sub[me.id] } : null,
    sessions: ss.filter(x => x.status === "open" && x.ts > Date.now()).sort((a, b) => a.ts - b.ts).slice(0, 40).map(x => {
      const n = live.filter(b => b.sid === x.id);
      return { id: x.id, coach: cn.get(x.coach) || "Coach", kind: x.kind, ts: x.ts, title: x.title, price: x.price, dur: x.dur || 60, left: x.cap - n.length, mine: n.some(b => b.player === me.id), own: x.coach === me.id };
    }),
    bookings: await Promise.all(bk.filter(b => b.player === me.id).slice(-10).map(async b => ({ ...b, cn: await nm(b.coach), pay: cp.get(b.coach) || "", dur: b.dur || sm.get(b.sid)?.dur || 60, title: sm.get(b.sid)?.title || b.kind }))),
    homework: await Promise.all(hw.filter(h => h.student === me.id).slice(-15).map(async h => ({ ...h, cn: await nm(h.coach) }))),
    board: bd.map(u => ({ n: u.n, e: u.e, x: u.x, t: u.t, me: u.id === me.id })),
  };
  if (me.role !== "player") {
    // roster = durable list on the coach record (survives booking-log trimming) + anything still in the log
    const mine = bk.filter(b => b.coach === me.id), sid = [...new Set([...(me.stu || []), ...mine.filter(b => b.status === "attended").map(b => b.player)])];
    out.coach = {
      bookings: await Promise.all(mine.slice(-30).reverse().map(async b => ({ ...b, pn: await nm(b.player), title: sm.get(b.sid)?.title }))),
      students: (await Promise.all(sid.map(id => getU(s, id)))).filter(Boolean).map(u => ({ id: u.id, n: u.username, t: tierOf(u) })),
      hw: await Promise.all(hw.filter(h => h.coach === me.id).slice(-30).reverse().map(async h => ({ ...h, sn: await nm(h.student) }))),
      sessions: ss.filter(x => x.coach === me.id && x.status === "open" && x.ts > Date.now() - 36e5).sort((a, b) => a.ts - b.ts).slice(0, 40)
        .map(x => ({ id: x.id, kind: x.kind, ts: x.ts, dur: x.dur || 60, title: x.title, price: x.price, cap: x.cap, booked: live.filter(b => b.sid === x.id).length })),
      who: Object.fromEntries(await Promise.all([...new Set(live.filter(b => b.coach === me.id).map(b => b.sid))].map(async sid => [sid, await Promise.all(live.filter(b => b.sid === sid).map(b => nm(b.player)))]))),
      revenue: mine.filter(b => b.paid && b.status !== "cancelled").reduce((t, b) => t + (b.price | 0), 0),
      due: mine.filter(b => !b.paid && b.status !== "cancelled").reduce((t, b) => t + (b.price | 0), 0) };
  }
  if (me.role === "admin") {
    out.admin = { cfg, disputes: await Promise.all(ms.filter(m => m.status !== "done").map(async m => ({ id: m.id, court: m.court, st: m.status,
      age: Math.round((Date.now() - m.start) / 6e4), A: [await nm(m.p[0]), await nm(m.p[1])], B: [await nm(m.p[2]), await nm(m.p[3])],
      sub: await Promise.all(Object.entries(m.sub).map(async ([k, v]) => (await nm(k)) + ": " + v.join("-"))) }))) };
    out.admin.flags = await Promise.all(ms.filter(m => m.flag).slice(-8).map(async m => ({ id: m.id, names: await Promise.all(m.p.map(id => nm(id))) })));
    if (full) out.admin.users = (await loadAll(s)).map(pub);
  }
  return out;
}
const goodStr = x => typeof x === "string" && TOK.test(x);
const int = (x, a, b) => Number.isInteger(x) && x >= a && x <= b;

async function handle(req, context) {
  if (req.method !== "POST") return E("POST only", 405);
  let b; try { b = await req.json(); } catch { return E("bad json"); }
  const s = getStore({ name: "the-system", consistency: "strong" }), a = b.action;
  const cfg = { ...DEF, ...(await jget(s, "cfg", {})) };

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "?";
  if (a === "login") {
    await boot(s);
    const n = String(b.username || "").toLowerCase(), pw = String(b.password || "");
    if ((await Promise.all([locked(s, "u:" + n, 8, 9e5), locked(s, "i:" + ip, 40, 9e5)])).some(Boolean)) return E("Too many attempts. Try again in 15 minutes.", 429);
    const u = await byName(s, n);
    if (!u && n === "admin" && !process.env.ADMIN_PASSWORD) return E("Admin not set up: add ADMIN_PASSWORD in Netlify environment variables, then redeploy", 503);
    if (pw.length < 1 || pw.length > 128 || !(await verify(s, u, pw))) { await Promise.all([hit(s, "u:" + n, 9e5), hit(s, "i:" + ip, 9e5)]); return E("bad credentials", 401); }
    if (u.disabled) return E("This account is disabled", 403);
    return J({ token: await token(s, u) });
  }
  if (a === "register") {
    const n = String(b.username || ""), pw = String(b.password || "");
    if (!NAME.test(n) || pw.length < 6 || pw.length > 128) return E("invalid");
    if (RESERVED.has(n.toLowerCase())) return E("taken", 409);
    // Generous enough for a launch night where everyone signs up on the club's Wi-Fi (one shared IP).
    if (await locked(s, "r:" + ip, 40, 36e5)) return E("Too many sign-ups from this network", 429);
    if (await byName(s, n)) return E("taken", 409);
    await hit(s, "r:" + ip, 36e5);
    const u = newUser(n); await setPw(u, pw);
    if (!(await createUser(s, u))) return E("taken", 409);
    return J({ token: await token(s, u) });
  }

  const me = await auth(s, req);
  if (!me) return E("unauthorized", 401);
  const coach = me.role === "certified_coach" || me.role === "admin", admin = me.role === "admin";
  const CFGW = ["setCfg", "invite", "redeem"].includes(a);
  const ok = async (msg) => J({ msg: msg || "", ...(await snapshot(s, a === "state" ? me : await getU(s, me.id), CFGW ? { ...DEF, ...(await jget(s, "cfg", {})) } : cfg, !!b.full)) });

  if (a === "state") {
    // Queued players' polls also run matchmaking, so a freed court or an expired cross-tier wait is picked up
    // without waiting for someone else to join. matchmake writes nothing when there is nothing to do.
    if ((await jget(s, "q", [])).some(x => x.id === me.id && fresh(x))) { await matchmake(s, cfg); return ok(); }
    return ok();
  }
  if (a === "survey") { // self-assessed skill profile: 6 traits, each 1-5; retake every 14 days
    const v = Array.isArray(b.v) ? b.v.map(Number) : [];
    if (v.length !== 6 || !v.every(x => int(x, 1, 5))) return E("Answer every question");
    await mutU(s, me.id, u => { if (u.sk && Date.now() - u.sk.t < 14 * 864e5) throw new Bad("You can retake the survey every 14 days"); u.sk = { v, t: Date.now() }; });
    return ok("Skill profile saved");
  }
  if (a === "changePw") {
    const np = String(b.newPw || ""), k = "u:" + me.username.toLowerCase();
    if (await locked(s, k, 8, 9e5)) return E("Too many attempts", 429);
    if (np.length < 6 || np.length > 128) return E("Use 6 to 128 characters");
    if (!(await verify(s, me, String(b.oldPw || "")))) { await hit(s, k, 9e5); return E("wrong password"); }
    let nu; await mutU(s, me.id, async u => { u.tv = (u.tv | 0) + 1; u.defaultPw = false; await setPw(u, np); nu = u; });
    return J({ token: await token(s, nu), ...(await snapshot(s, nu, { ...DEF, ...(await jget(s, "cfg", {})) }, !!b.full)), msg: "Password changed" });
  }

  // ---- Player: check-in, queue, scores
  if (a === "checkin") {
    if (cfg.qr) {
      const k = "c:" + me.id;
      if (await locked(s, k, 10, 9e5)) return E("Too many wrong codes. Try again later.", 429);
      if (!(await qrOk(s, String(b.code || "")))) { await hit(s, k, 9e5); return E("Invalid or expired code. Use the screen at the facility."); }
    } else if (cfg.lat != null && cfg.lng != null) {
      if (typeof b.lat !== "number" || typeof b.lng !== "number") return E("Location required to check in");
      if (dist(cfg.lat, cfg.lng, b.lat, b.lng) > cfg.rad) return E("You are not at the facility");
    }
    await mutU(s, me.id, u => { u.ci = Date.now(); });
    return ok("Checked in for 4 hours");
  }
  if (a === "join") {
    if (Date.now() - me.ci > 4 * 36e5) return E("Check in at the facility first");
    await expire(s);
    if ((await jget(s, "m", [])).some(m => m.status !== "done" && m.p.includes(me.id))) return E("You are already in a match");
    await mutate(s, "q", [], q => { const f = q.filter(fresh); if (!f.some(x => x.id === me.id)) f.push({ id: me.id, tier: tierOf(me), t: Date.now() }); return f; });
    await matchmake(s, cfg);
    return ok("In the queue");
  }
  if (a === "leave") {
    await mutate(s, "q", [], q => q.filter(x => x.id !== me.id));
    return ok();
  }
  if (a === "score") {
    let plan = null, st;
    await mutate(s, "m", [], async ms => {
      plan = null;
      const m = ms.find(x => x.id === b.matchId);
      if (!m || m.status !== "playing" || !m.p.includes(me.id)) throw new Bad("no active match");
      const x = +b.a, y = +b.b, hi = Math.max(x, y), lo = Math.min(x, y);
      if (!int(x, 0, 30) || !int(y, 0, 30) || hi < 11 || (lo <= 9 ? hi !== 11 : hi - lo !== 2)) throw new Bad("Invalid score: first to 11, win by 2");
      if (Date.now() - m.start < cfg.minMin * 6e4) throw new Bad(`Match too short (min ${cfg.minMin} min)`);
      m.sub[me.id] = [x, y]; // [teamA score, teamB score]
      const subs = Object.entries(m.sub), teamOf = id => (m.p.indexOf(id) < 2 ? 0 : 1);
      const A = subs.filter(([id]) => teamOf(id) === 0), B = subs.filter(([id]) => teamOf(id) === 1);
      if (A.length && B.length) {
        if (A.some(([, v]) => B.some(([, w]) => v[0] !== w[0] || v[1] !== w[1]))) m.status = "disputed";
        else plan = await planFinish(s, m, A[0][1][0], A[0][1][1], ms, cfg.tz);
      }
      st = m.status;
    });
    await applyPlan(s, plan);
    if (st === "done") await matchmake(s, cfg);
    return ok(st === "done" ? "Score confirmed" : st === "disputed" ? "Scores differ: sent to admin" : "Waiting for the other team to confirm");
  }

  // ---- Quests
  if (a === "claim") {
    const q = todays(cfg.tz).find(x => x.id === b.qid);
    if (!q) return E("Not available");
    let gained = 0;
    await mutU(s, me.id, u => { if (u.done.includes(q.id)) throw new Bad("Not available"); u.done = [...u.done, q.id].slice(-60); const x0 = u.xp; addXp(u, q.xp); gained = u.xp - x0; });
    return ok(gained > 0 ? `+${gained} XP` : "Tier ceiling reached: XP is banked until your next badge");
  }

  // ---- Bookings, coach tools
  if (a === "book") {
    await mutate(s, "bk", [], async bk => {
      const x = (await jget(s, "ss", [])).find(v => v.id === b.sessionId);
      if (!x || x.status !== "open" || x.ts < Date.now() || x.coach === me.id) throw new Bad("Session not available");
      const live = bk.filter(v => v.sid === x.id && v.status !== "cancelled");
      if (live.some(v => v.player === me.id)) throw new Bad("Already booked");
      if (live.length >= x.cap) throw new Bad("Session is full");
      if (bk.some(v => v.player === me.id && v.status === "booked" && v.ts < x.ts + (x.dur || 60) * 6e4 && x.ts < v.ts + (v.dur || 60) * 6e4)) throw new Bad("You already have a booking at that time");
      bk.push({ id: uid(), sid: x.id, coach: x.coach, player: me.id, kind: x.kind, ts: x.ts, dur: x.dur || 60, made: Date.now(), price: x.price, paid: false, status: "booked" });
      trim(bk, 1000, v => (v.status === "booked" && v.ts > Date.now() - 864e5) || (!v.paid && v.price && v.status !== "cancelled"));
    });
    return ok("Booked. Show your booking code to the coach.");
  }
  if (a === "cancel") {
    await mutate(s, "bk", [], bk => {
      const k = bk.find(v => v.id === b.id && v.player === me.id);
      if (!k || k.status !== "booked") throw new Bad("Not found");
      if (k.ts - Date.now() < 2 * 36e5) throw new Bad("Too late to cancel (2 hour policy). Contact your coach.");
      k.status = "cancelled";
    });
    return ok("Booking cancelled");
  }
  if (a === "ref") {
    const r = String(b.ref || "").trim();
    if (!/^[A-Za-z0-9 -]{4,24}$/.test(r)) return E("Enter the reference number from your e-wallet receipt");
    await mutate(s, "bk", [], bk => {
      const k = bk.find(v => v.id === b.id && v.player === me.id && v.status !== "cancelled");
      if (!k) throw new Bad("Not found");
      k.ref = r;
    });
    return ok("Reference sent to your coach");
  }
  if (a === "redeem") {
    if (me.role !== "player") return E("You are already a coach or admin");
    const t = String(b.token || "");
    await mutate(s, "cfg", {}, c => { const inv = c.inv || []; const i = inv.indexOf(t); if (i < 0) throw new Bad("Invalid invite"); inv.splice(i, 1); c.inv = inv; });
    await mutU(s, me.id, u => { u.role = "certified_coach"; }); await coaches(s, true);
    return ok("You are now a Certified Coach");
  }
  if (["attend", "assess", "assign", "approve", "addSession", "cancelSession", "paid", "setPay"].includes(a)) {
    if (!coach) return E("forbidden", 403);
    if (a === "setPay") {
      const text = String(b.text || "").trim().slice(0, 120);
      await mutU(s, me.id, u => { u.pay = text; }); await coaches(s, true);
      return ok("Payment details saved");
    }
    if (a === "addSession") {
      const ts = +b.ts, price = Math.round(+b.price * 100), kind = b.kind === "clinic" ? "clinic" : "lesson", title = String(b.title || "").trim().slice(0, 60);
      const cap = kind === "lesson" ? 1 : Math.min(24, Math.max(2, +b.cap | 0 || 8)), dur = Math.min(240, Math.max(30, +b.dur | 0 || (kind === "clinic" ? 90 : 60)));
      if (!title || !(ts > Date.now() && ts < Date.now() + 90 * 864e5) || !(price >= 0 && price <= 10000000)) return E("Check title, a future time (within 90 days) and price");
      await mutate(s, "ss", [], ss => {
        if (ss.some(v => v.coach === me.id && v.status === "open" && v.ts < ts + dur * 6e4 && ts < v.ts + (v.dur || 60) * 6e4)) throw new Bad("That overlaps another of your sessions");
        if (ss.filter(v => v.coach === me.id && v.status === "open" && v.ts > Date.now()).length >= 60) throw new Bad("Too many open sessions");
        ss.push({ id: uid(), coach: me.id, kind, ts, title, price, cap, dur, status: "open" });
        trim(ss, 500, v => v.status === "open" && v.ts > Date.now() - 864e5);
      });
      return ok("Session published");
    }
    if (a === "cancelSession") {
      let sid;
      await mutate(s, "ss", [], ss => { const x = ss.find(v => v.id === b.sid && v.coach === me.id && v.status === "open"); if (!x) throw new Bad("Not found"); x.status = "cancelled"; sid = x.id; });
      await mutate(s, "bk", [], bk => { let ch = false; bk.forEach(v => { if (v.sid === sid && v.status === "booked") { v.status = "cancelled"; ch = true; } }); return ch ? undefined : SKIP; });
      return ok("Session cancelled, bookings released");
    }
    if (a === "paid") {
      let paid;
      await mutate(s, "bk", [], bk => { const k = bk.find(v => v.id === b.id && v.coach === me.id && v.status !== "cancelled"); if (!k) throw new Bad("Not found"); k.paid = !k.paid; paid = k.paid; });
      return ok(paid ? "Marked paid" : "Marked unpaid");
    }
    if (a === "attend") {
      let pid;
      await mutate(s, "bk", [], bk => {
        const k = bk.find(x => x.id === String(b.id || "").trim() && x.coach === me.id);
        if (!k || k.status !== "booked") throw new Bad("Booking not found");
        if (k.sid && (Date.now() < k.ts - 2 * 36e5 || Date.now() > k.ts + 4 * 36e5)) throw new Bad("Check-in opens 2 hours before the session and closes 4 hours after it starts");
        k.status = "attended"; pid = k.player;
      });
      await Promise.all([giveXp(s, pid, 40), mutU(s, me.id, u => { u.stu = [...new Set([...(u.stu || []), pid])].slice(-500); })]);
      return ok("Checked in: +40 XP to player");
    }
    if (a === "approve") {
      let h2;
      await mutate(s, "hw", [], hw => { // only the assigning coach can sign off
        const h = hw.find(x => x.id === b.id && x.coach === me.id);
        if (!h || h.status !== "open" || h.student === me.id) throw new Bad("Not found");
        h.status = "done"; h2 = { st: h.student, xp: h.xp };
      });
      await giveXp(s, h2.st, h2.xp);
      return ok(`Approved: +${h2.xp} XP`);
    }
    // assess / assign: student must have an attended session with this coach
    const pid = String(b.playerId || ""), bk = await jget(s, "bk", []);
    if (pid === me.id || !((me.stu || []).includes(pid) || bk.some(x => x.coach === me.id && x.player === pid && x.status === "attended"))) return E("Student has no attended session with you");
    if (a === "assess") {
      const d = BADGES[b.badge];
      if (!d) return E("Unknown badge");
      if (b.pass !== true) return ok("Marked: not yet");
      let name;
      await mutU(s, pid, u => {
        if (u.badges.includes(b.badge)) throw new Bad("Already earned");
        if (d.tier !== tierOf(u) + 1) throw new Bad("Earn the previous tier badge first");
        u.badges.push(b.badge); const bank = u.bank | 0; u.bank = 0; addXp(u, 100 + bank); name = u.username;
      });
      return ok(`${d.n} awarded to ${name}`);
    }
    if (a === "assign") {
      const t = String(b.title || "").trim().slice(0, 120), xp = Math.min(100, Math.max(10, +b.xp | 0 || 30));
      if (!t) return E("Title required");
      await mutate(s, "hw", [], hw => { hw.push({ id: uid(), coach: me.id, student: pid, title: t, xp, status: "open", ts: Date.now() }); trim(hw, 1000, v => v.status === "open"); });
      return ok("Homework assigned");
    }
  }

  // ---- Admin
  if (!admin) return E("forbidden", 403);
  if (a === "setRole") {
    const id = String(b.id || "");
    if (!ROLE.includes(b.role) || (id === me.id && b.role !== "admin")) return E("invalid");
    await mutU(s, id, u => { u.role = b.role; }); await coaches(s, true);
    return ok("Role updated");
  }
  if (a === "resetElo") {
    await mutU(s, String(b.id || ""), u => { u.elo = 1000; });
    return ok("Rank reset");
  }
  if (a === "resolve") {
    let plan = null;
    await mutate(s, "m", [], async ms => {
      plan = null;
      const m = ms.find(x => x.id === b.matchId && x.status === "disputed"), x = +b.a, y = +b.b;
      if (!m || !int(x, 0, 30) || !int(y, 0, 30) || x === y) throw new Bad("invalid");
      plan = await planFinish(s, m, x, y, ms, cfg.tz);
    });
    await applyPlan(s, plan); await matchmake(s, cfg);
    return ok("Score set");
  }
  if (a === "qrCode") return J({ code: await qrAt(s, Math.floor(Date.now() / 6e4)) });
  if (a === "setDisabled") {
    const id = String(b.id || "");
    if (id === me.id) return E("invalid");
    await mutU(s, id, u => { u.disabled = !!b.disabled; }); await coaches(s, true);
    await mutate(s, "q", [], q => q.filter(x => x.id !== id));
    return ok(b.disabled ? "User disabled" : "User enabled");
  }
  if (a === "voidMatch") {
    await mutate(s, "m", [], ms => { const m = ms.find(x => x.id === b.matchId && x.status !== "done"); if (!m) throw new Bad("invalid"); m.status = "done"; m.void = true; m.end = Date.now(); });
    await matchmake(s, cfg);
    return ok("Match voided");
  }
  if (a === "setCfg") {
    const courts = String(b.courts || "").split(",").map(x => x.trim().slice(0, 20)).filter(Boolean).slice(0, 30);
    let tz = cfg.tz;
    try { if (b.tz) { new Intl.DateTimeFormat("en-CA", { timeZone: String(b.tz) }); tz = String(b.tz); } } catch { return E("Unknown time zone"); }
    const lat = b.lat === "" || b.lat == null ? null : +b.lat, lng = b.lng === "" || b.lng == null ? null : +b.lng;
    if ((lat == null) !== (lng == null) || (lat != null && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180))) return E("Enter both latitude (-90 to 90) and longitude (-180 to 180), or leave both blank");
    await mutate(s, "cfg", {}, c => { // field-level merge: never clobbers invite tokens issued meanwhile
      Object.assign(c, { tz, qr: !!b.qr, courts: [...new Set(courts.length ? courts : cfg.courts)], lat, lng, rad: Math.min(2000, Math.max(30, +b.rad || 150)), minMin: Math.min(30, Math.max(0, +b.minMin || 0)) });
    });
    return ok("Settings saved");
  }
  if (a === "invite") {
    const t = randomBytes(6).toString("hex");
    await mutate(s, "cfg", {}, c => { c.inv = [...(c.inv || []), t].slice(-20); });
    return ok("Invite: " + t);
  }
  return E("unknown action");
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { if (e instanceof Bad) return E(e.message, e.st); console.error(e); return E("Server error", 500); }
};

export const config = { path: "/api" };
