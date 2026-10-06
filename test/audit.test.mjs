// Regression tests for the issues found in the v7.2 audit. Each one failed on v7.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __dump } from "@netlify/blobs";
import { fresh, advance, MIN, HOUR, DAY } from "./helpers/harness.mjs";

let ipn = 0;
const ip = () => "10.9.0." + ++ipn;
const ADMIN = { ADMIN_PASSWORD: "club-admin-pw" };

test("a fresh deploy without ADMIN_PASSWORD does not open admin/admin to the world", async () => {
  const c = await fresh();
  const r = await c.call("login", { username: "admin", password: "admin" });
  assert.notEqual(r.status, 200);
});

test("nobody can register the reserved 'admin' name and lock the real admin out", async () => {
  const c = await fresh(ADMIN);
  for (const n of ["admin", "Admin", "ADMIN"]) assert.equal((await c.call("register", { username: n, password: "secret123" }, "", ip())).status, 409, n);
  const r = await c.call("login", { username: "admin", password: ADMIN.ADMIN_PASSWORD });
  assert.equal(r.status, 200);
});

test("a launch night on club Wi-Fi: 25 sign-ups from one IP all succeed", async () => {
  const c = await fresh(ADMIN);
  for (let i = 0; i < 25; i++) {
    const r = await c.call("register", { username: "member" + i, password: "secret123" }, "", "203.0.113.7");
    assert.equal(r.status, 200, "sign-up " + (i + 1));
  }
});

test("players stuck in a thin tier get matched with the next tier after waiting", async () => {
  const c = await fresh(ADMIN);
  const at = (await c.ok("login", { username: "admin", password: ADMIN.ADMIN_PASSWORD })).token;
  const ci = (await c.ok("invite", {}, at)).msg.replace("Invite: ", "");
  const coach = await c.register("coachz", ip()); await c.ok("redeem", { token: ci }, coach);
  // promote two players to Intermediate through the real coach flow
  const inter = [];
  for (const n of ["ivy", "jax"]) {
    const t = await c.player(n, ip());
    await c.ok("addSession", { kind: "lesson", ts: Date.now() + HOUR + inter.length * 2 * HOUR, title: "Eval", price: 0 }, coach);
    const s = (await c.ok("state", {}, t)).sessions.find(x => !x.mine && x.left > 0);
    await c.ok("book", { sessionId: s.id }, t);
    const b = (await c.ok("state", {}, t)).bookings[0];
    advance(b.ts - Date.now()); // jump to the lesson
    await c.ok("attend", { id: b.id }, coach);
    await c.ok("assess", { playerId: (await c.ok("state", {}, t)).me.id, badge: "dink_master", pass: true }, coach);
    await c.ok("checkin", {}, t);
    inter.push(t);
  }
  const beg = [await c.player("kai", ip()), await c.player("lux", ip())];
  for (const t of [...inter, ...beg]) await c.ok("join", {}, t);
  assert.equal((await c.ok("state", {}, inter[0])).match, null, "no instant cross-tier match");
  advance(11 * MIN);
  const s = await c.ok("state", {}, beg[0]); // an ordinary poll is enough to trigger it
  assert.ok(s.match, "matched after waiting");
});

test("a freed court is filled on the next poll, not only on the next join", async () => {
  const c = await fresh(ADMIN);
  const at = (await c.ok("login", { username: "admin", password: ADMIN.ADMIN_PASSWORD })).token;
  await c.ok("setCfg", { courts: "Court 1", rad: 150, minMin: 5, tz: "UTC" }, at);
  const ts = [];
  for (let i = 0; i < 8; i++) { ts.push(await c.player("plr" + i, ip())); await c.ok("join", {}, ts[i]); }
  assert.equal((await c.ok("state", {}, ts[7])).match, null, "only one court");
  await c.ok("setCfg", { courts: "Court 1, Court 2", rad: 150, minMin: 5, tz: "UTC" }, at);
  assert.equal((await c.ok("state", {}, ts[7])).match?.court, "Court 2");
});

test("a coach keeps their students after the booking log is trimmed", async () => {
  const c = await fresh(ADMIN);
  const at = (await c.ok("login", { username: "admin", password: ADMIN.ADMIN_PASSWORD })).token;
  const ci = (await c.ok("invite", {}, at)).msg.replace("Invite: ", "");
  const coach = await c.register("coachy", ip()); await c.ok("redeem", { token: ci }, coach);
  const p = await c.player("stu", ip());
  await c.ok("addSession", { kind: "lesson", ts: Date.now() + HOUR, title: "Intro", price: 0 }, coach);
  await c.ok("book", { sessionId: (await c.ok("state", {}, p)).sessions[0].id }, p);
  await c.ok("attend", { id: (await c.ok("state", {}, p)).bookings[0].id }, coach);
  // 1,000 newer bookings from other activity push the old attended one out of the log
  const store = __dump(), bk = JSON.parse(store.get("bk").v);
  for (let i = 0; i < 1000; i++) bk.push({ id: "f" + i, sid: "x", coach: "zz", player: "yy", kind: "lesson", ts: 1, dur: 60, made: 1, price: 0, paid: false, status: "cancelled" });
  store.set("bk", { v: JSON.stringify(bk), etag: "manual" });
  const p2 = await c.player("trig", ip());
  await c.ok("addSession", { kind: "lesson", ts: Date.now() + 5 * HOUR, title: "Later", price: 0 }, coach);
  await c.ok("book", { sessionId: (await c.ok("state", {}, p2)).sessions.find(x => x.left > 0).id }, p2); // triggers the trim
  const st = await c.ok("state", {}, coach);
  assert.equal(st.coach.students.length, 1, "student still listed");
  await c.ok("assign", { playerId: st.coach.students[0].id, title: "Wall dinks", xp: 20 }, coach);
});

test("daily quests rotate through more than two fixed sets", async () => {
  const c = await fresh(ADMIN);
  const t = await c.player("quest", ip());
  const sets = new Set();
  for (let d = 0; d < 8; d++) { sets.add((await c.ok("state", {}, t)).today.map(q => q.t).sort().join("|")); advance(DAY); }
  assert.ok(sets.size > 2, `only ${sets.size} distinct quest sets in 8 days`);
});

test("cross-tier fill never puts Beginner and Advanced players on the same court", async () => {
  const c = await fresh(ADMIN);
  const { __dump: dump } = await import("@netlify/blobs");
  const ts = [];
  for (const n of ["bga", "bgb", "adv", "adw"]) ts.push(await c.player(n, ip()));
  // two Beginners, one Intermediate, one Advanced: the only "full" mix would span Beginner to Advanced
  const now = Date.now(), ids = await Promise.all(ts.map(async t => (await c.ok("state", {}, t)).me.id));
  dump().set("q", { v: JSON.stringify(ids.map((id, i) => ({ id, tier: [0, 0, 1, 2][i], t: now + i }))), etag: "manual2" });
  advance(20 * MIN);
  await c.ok("checkin", {}, ts[0]);
  assert.equal((await c.ok("state", {}, ts[0])).match, null);
});

test("eight queued players fill two free courts at once", async () => {
  const c = await fresh(ADMIN);
  const { __dump: dump } = await import("@netlify/blobs");
  const ts = [];
  for (let i = 0; i < 8; i++) ts.push(await c.player("eight" + i, ip()));
  // queue all eight without triggering matchmaking, then let one poll do the work
  const now = Date.now(), ids = await Promise.all(ts.map(async t => (await c.ok("state", {}, t)).me.id));
  dump().set("q", { v: JSON.stringify(ids.map((id, i) => ({ id, tier: 0, t: now + i }))), etag: "manual3" });
  await c.ok("state", {}, ts[0]);
  const courts = new Set((await Promise.all(ts.map(t => c.ok("state", {}, t)))).map(s => s.match?.court));
  assert.deepEqual([...courts].sort(), ["Court 1", "Court 2"]);
});

test("simultaneous joins start exactly one match; simultaneous confirmations pay XP once", async () => {
  const c = await fresh(ADMIN);
  const ts = [];
  for (const n of ["cca", "ccb", "ccc", "ccd"]) ts.push(await c.player(n, ip()));
  await Promise.all(ts.map(t => c.ok("join", {}, t)));
  const ss = await Promise.all(ts.map(t => c.ok("state", {}, t)));
  assert.equal(new Set(ss.map(s => s.match?.id)).size, 1);
  advance(6 * MIN);
  const id = ss[0].match.id;
  await Promise.all(ts.map(t => c.call("score", { matchId: id, a: 11, b: 4 }, t)));
  const xp = (await Promise.all(ts.map(t => c.ok("state", {}, t)))).map(s => s.me.xp).sort();
  assert.deepEqual(xp, [10, 10, 30, 30]);
});

test("admin can reset a forgotten password: old sessions end, temp password works once changed", async () => {
  const c = await fresh(ADMIN);
  const at = (await c.ok("login", { username: "admin", password: ADMIN.ADMIN_PASSWORD })).token;
  const t = await c.register("forgetful", ip());
  for (let i = 0; i < 8; i++) await c.call("login", { username: "forgetful", password: "guess" + i }); // locked out
  const id = (await c.ok("state", {}, t)).me.id;
  const r = await c.ok("resetPw", { id }, at);
  const tmp = r.msg.split(": ").pop();
  assert.equal((await c.call("state", {}, t)).status, 401, "old session revoked");
  const nt = (await c.ok("login", { username: "forgetful", password: tmp })).token; // lockout cleared
  assert.equal((await c.ok("state", {}, nt)).me.mustChange, true);
  const ct = (await c.ok("changePw", { oldPw: tmp, newPw: "brandnew1" }, nt)).token;
  assert.equal((await c.ok("state", {}, ct)).me.mustChange, false);
  assert.equal((await c.call("resetPw", { id }, t)).status, 401);
  assert.equal((await c.call("resetPw", { id }, ct)).status, 403, "players can't reset passwords");
});
