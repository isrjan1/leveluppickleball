// Regression coverage for existing behaviour: auth, ranked queue + scoring, disputes, coaching, bookings, quests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, advance, MIN, HOUR } from "./helpers/harness.mjs";

let ipn = 0;
const ip = () => "10.0.0." + ++ipn;
const ADMIN = { ADMIN_PASSWORD: "club-admin-pw" };
const adminToken = async c => (await c.ok("login", { username: "admin", password: ADMIN.ADMIN_PASSWORD })).token;

test("admin bootstraps from ADMIN_PASSWORD; wrong passwords are rate limited", async () => {
  const c = await fresh(ADMIN);
  const t = await adminToken(c);
  assert.equal((await c.ok("state", {}, t)).me.role, "admin");
  for (let i = 0; i < 8; i++) assert.equal((await c.call("login", { username: "admin", password: "nope" + i })).status, 401);
  assert.equal((await c.call("login", { username: "admin", password: ADMIN.ADMIN_PASSWORD })).status, 429);
});

test("usernames are unique case-insensitively; tokens die on password change", async () => {
  const c = await fresh(ADMIN);
  const t = await c.register("Dinker", ip());
  assert.equal((await c.call("register", { username: "dinker", password: "secret123" }, "", ip())).status, 409);
  const r = await c.ok("changePw", { oldPw: "secret123", newPw: "newsecret1" }, t);
  assert.ok(r.token);
  assert.equal((await c.call("state", {}, t)).status, 401, "old token must be revoked");
  assert.equal((await c.call("state", {}, r.token)).status, 200);
});

test("four checked-in players get a balanced match; a score confirmed by all four moves rating and XP once", async () => {
  const c = await fresh(ADMIN);
  const ts = [];
  for (const n of ["ana", "ben", "cai", "dee"]) ts.push(await c.player(n, ip()));
  for (const t of ts.slice(0, 3)) await c.ok("join", {}, t);
  const last = await c.ok("join", {}, ts[3]);
  assert.ok(last.match, "4th join starts a match");
  assert.equal(last.match.court, "Court 1");
  const id = last.match.id;
  // team A = p[0],p[1]; find which tokens are on which team
  const teams = await Promise.all(ts.map(async t => { const s = await c.ok("state", {}, t); return s.match.A.includes(s.me.username) ? "A" : "B"; }));
  assert.equal((await c.call("score", { matchId: id, a: 11, b: 5 }, ts[0])).status, 400, "minimum match time enforced");
  advance(6 * MIN);
  assert.equal((await c.call("score", { matchId: id, a: 11, b: 10 }, ts[0])).status, 400, "win by 2");
  assert.equal((await c.call("score", { matchId: id, a: 12, b: 5 }, ts[0])).status, 400, "games end at 11, 15 or 21");
  const aTok = ts[teams.indexOf("A")], bTok = ts[teams.indexOf("B")];
  await c.ok("score", { matchId: id, a: 11, b: 5 }, aTok);
  const half = await c.ok("score", { matchId: id, a: 11, b: 5 }, bTok);
  assert.match(half.msg, /counts once everyone confirms/);
  for (const t of ts.filter(t => t !== aTok && t !== bTok)) await c.ok("score", { matchId: id, a: 11, b: 5 }, t);
  const states = await Promise.all(ts.map(t => c.ok("state", {}, t)));
  for (let i = 0; i < 4; i++) {
    const me = states[i].me;
    // all four are new (NR, provisional 3.5 from an all-3 survey); 11-5 beats the expected 50% share by 0.1875,
    // x K 1 (new player) x 0.5 (no rated opponents) = 0.094
    if (teams[i] === "A") { assert.equal(me.w, 1); assert.equal(me.xp, 30); assert.equal(me.pr, 3.594); }
    else { assert.equal(me.l, 1); assert.equal(me.xp, 10); assert.equal(me.pr, 3.406); }
    assert.equal(me.r, undefined, "still NR after one match");
    assert.equal(me.hist.length, 1);
    assert.equal(states[i].match, null);
  }
  assert.equal((await c.call("score", { matchId: id, a: 11, b: 5 }, aTok)).status, 400, "cannot score a finished match");
});

test("mismatched scores go to the admin, who resolves them", async () => {
  const c = await fresh(ADMIN);
  const ts = [];
  for (const n of ["eve", "fin", "gus", "hal"]) { ts.push(await c.player(n, ip())); await c.ok("join", {}, ts.at(-1)); }
  const s0 = await c.ok("state", {}, ts[0]), id = s0.match.id;
  advance(6 * MIN);
  const team = async t => { const s = await c.ok("state", {}, t); return s.match.A.includes(s.me.username) ? "A" : "B"; };
  const A = [], B = [];
  for (const t of ts) ((await team(t)) === "A" ? A : B).push(t);
  await c.ok("score", { matchId: id, a: 11, b: 5 }, A[0]);
  const r = await c.ok("score", { matchId: id, a: 5, b: 11 }, B[0]);
  assert.match(r.msg, /admin/);
  const at = await adminToken(c);
  const adm = await c.ok("state", {}, at);
  assert.equal(adm.admin.disputes[0].st, "disputed");
  await c.ok("resolve", { matchId: id, a: 11, b: 7 }, at);
  assert.equal((await c.ok("state", {}, A[0])).me.w, 1);
});

test("coach flow: invite, publish, book, capacity, cancel policy, attend, badge, homework", async () => {
  const c = await fresh(ADMIN);
  const at = await adminToken(c);
  const tok = (await c.ok("invite", {}, at)).msg.replace("Invite: ", "");
  const ct = await c.register("coachkim", ip());
  await c.ok("redeem", { token: tok }, ct);
  assert.equal((await c.call("redeem", { token: tok }, await c.register("sneaky", ip()))).status, 400, "invites are single-use");
  const when = Date.now() + 3 * HOUR;
  await c.ok("addSession", { kind: "lesson", ts: when, title: "Dink basics", price: 800, dur: 60 }, ct);
  assert.equal((await c.call("addSession", { kind: "lesson", ts: when + 30 * MIN, title: "Overlap", price: 0 }, ct)).status, 400);
  const p1 = await c.player("pia", ip()), p2 = await c.player("quin", ip());
  const sid = (await c.ok("state", {}, p1)).sessions[0].id;
  await c.ok("book", { sessionId: sid }, p1);
  assert.equal((await c.call("book", { sessionId: sid }, p1)).status, 400, "no double booking");
  assert.equal((await c.call("book", { sessionId: sid }, p2)).status, 400, "lesson holds one player");
  const bid = (await c.ok("state", {}, p1)).bookings[0].id;
  advance(2 * HOUR); // now inside the 2h window
  assert.equal((await c.call("cancel", { id: bid }, p1)).status, 400, "2 hour cancellation policy");
  const r = await c.ok("attend", { id: bid }, ct);
  assert.match(r.msg, /\+40 XP/);
  const pid = (await c.ok("state", {}, p1)).me.id;
  await c.ok("assess", { playerId: pid, badge: "dink_master", pass: true }, ct);
  const me = (await c.ok("state", {}, p1)).me;
  assert.deepEqual(me.badges, ["dink_master"]);
  assert.equal(me.tier, 1);
  assert.equal(me.xp, 140);
  await c.ok("assign", { playerId: pid, title: "100 cross-court dinks", xp: 30 }, ct);
  const hid = (await c.ok("state", {}, ct)).coach.hw[0].id;
  await c.ok("approve", { id: hid }, ct);
  assert.equal((await c.ok("state", {}, p1)).me.xp, 170);
  // players outside the coach's roster are refused
  const pid2 = (await c.ok("state", {}, p2)).me.id;
  assert.equal((await c.call("assign", { playerId: pid2, title: "x" }, ct)).status, 400);
});

test("daily quests can be claimed once each", async () => {
  const c = await fresh(ADMIN);
  const t = await c.player("rae", ip());
  const s = await c.ok("state", {}, t);
  assert.equal(s.today.length, 3);
  await c.ok("claim", { qid: s.today[0].id }, t);
  assert.equal((await c.call("claim", { qid: s.today[0].id }, t)).status, 400);
  assert.equal((await c.ok("state", {}, t)).me.xp, s.today[0].xp);
});

test("non-admins cannot reach admin actions", async () => {
  const c = await fresh(ADMIN);
  const t = await c.register("mallory", ip());
  for (const a of ["setRole", "setCfg", "invite", "voidMatch", "qrCode", "setDisabled"]) assert.equal((await c.call(a, {}, t)).status, 403, a);
  for (const a of ["addSession", "attend", "assess"]) assert.equal((await c.call(a, {}, t)).status, 403, a);
});
