// Club rating rules (modelled on DUPR): margin vs expectation, NR initialization, reliability, confirmation, coach ratings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __dump } from "@netlify/blobs";
import { fresh, advance, MIN, HOUR, DAY } from "./helpers/harness.mjs";

let ipn = 0;
const ip = () => "10.7.0." + ++ipn;
const ADMIN = { ADMIN_PASSWORD: "club-admin-pw" };
const st = () => __dump();
const meId = async (c, t) => (await c.ok("state", {}, t)).me.id;
// overwrite fields on a stored user record (simulates established players)
const patch = (id, f) => { const s = st(), u = JSON.parse(s.get("u/" + id).v); Object.assign(u, f); s.set("u/" + id, { v: JSON.stringify(u), etag: "p" + Math.random() }); };
// a varied history so reliability is high (4 partners, 12 opposing teams, recent)
const richHist = () => Array.from({ length: 12 }, (_, i) => ({ t: Date.now() - i * HOUR, m: "h" + i, pt: "pt" + (i % 4), op: ["oa" + i, "ob" + i], s: [11, 7], d: 0, w: true }));

async function four(c, names) { const ts = []; for (const n of names) ts.push(await c.player(n, ip())); return ts; }
async function playMatch(c, ts, scoreFor) { // scoreFor(teamOfFirstPlayer) => [teamA, teamB]
  for (const t of ts) await c.ok("join", {}, t);
  const s = await Promise.all(ts.map(t => c.ok("state", {}, t)));
  const id = s[0].match.id, sides = s.map(x => x.match.side);
  advance(6 * MIN);
  const [a, b] = scoreFor(sides);
  for (const t of ts) await c.ok("score", { matchId: id, a, b }, t);
  return { id, sides };
}

test("winning by less than expected lowers the favourites; losing close raises the underdogs", async () => {
  const c = await fresh(ADMIN);
  const ts = await four(c, ["fav1", "fav2", "dog1", "dog2"]);
  const ids = await Promise.all(ts.map(t => meId(c, t)));
  ids.forEach((id, i) => patch(id, { r: i < 2 ? 5.25 : 4.25, hist: richHist() }));
  // matchmaking pairs strongest+weakest, so force the intended teams by placing the match ourselves
  await c.ok("state", {}, ts[0]);
  const s = st(); s.set("m", { v: JSON.stringify([{ id: "mfav", court: "Court 1", tier: 0, p: ids, start: Date.now(), status: "playing", sub: {} }]), etag: "m1" });
  const m = await c.ok("state", {}, ts[0]);
  assert.ok(m.match.exp > .7, "favourites expected to take well over 70% of points");
  advance(6 * MIN);
  for (const t of ts) await c.ok("score", { matchId: "mfav", a: 11, b: 8 }, t); // favourites win, but only 11-8
  const after = await Promise.all(ts.map(t => c.ok("state", {}, t)));
  assert.ok(after[0].me.r < 5.25 && after[1].me.r < 5.25, "winners went down");
  assert.ok(after[2].me.r > 4.25 && after[3].me.r > 4.25, "losers went up");
  assert.equal(after[0].me.w, 1);
  assert.match(after[0].me.last, /^Won 11-8: rating -0\.0/);
});

test("a single result can move a rating by at most 0.200", async () => {
  const c = await fresh(ADMIN);
  const ts = await four(c, ["big1", "big2", "sml1", "sml2"]);
  const ids = await Promise.all(ts.map(t => meId(c, t)));
  ids.forEach((id, i) => patch(id, { r: i < 2 ? 3.0 : 6.0, hist: [] })); // rated but zero reliability: largest K
  const s = st(); s.set("m", { v: JSON.stringify([{ id: "mup", court: "Court 1", tier: 0, p: ids, start: Date.now(), status: "playing", sub: {} }]), etag: "m2" });
  advance(6 * MIN);
  for (const t of ts) await c.ok("score", { matchId: "mup", a: 11, b: 0 }, t); // massive upset
  const r = await Promise.all(ts.map(t => c.ok("state", {}, t)));
  assert.equal(r[0].me.r, 3.2); assert.equal(r[3].me.r, 5.8);
});

test("new players are NR until 3 initialization points; three games against rated players make them rated", async () => {
  const c = await fresh(ADMIN);
  const ts = await four(c, ["newbie", "vet1", "vet2", "vet3"]);
  const ids = await Promise.all(ts.map(t => meId(c, t)));
  ids.slice(1).forEach(id => patch(id, { r: 3.5, hist: richHist() }));
  assert.equal((await c.ok("state", {}, ts[0])).me.r, undefined);
  for (let g = 0; g < 3; g++) {
    await playMatch(c, ts, () => [11, 9]);
    const me = (await c.ok("state", {}, ts[0])).me;
    if (g < 2) assert.equal(me.r, undefined, "NR after game " + (g + 1));
    else { assert.equal(typeof me.r, "number"); assert.match(me.last, /now rated/); }
  }
});

test("NR players become rated 7 days after their first match even with few points", async () => {
  const c = await fresh(ADMIN);
  const ts = await four(c, ["slow1", "slow2", "slow3", "slow4"]);
  await playMatch(c, ts, () => [11, 6]);
  assert.equal((await c.ok("state", {}, ts[0])).me.r, undefined);
  advance(8 * DAY);
  await c.ok("checkin", {}, ts[0]);
  assert.equal(typeof (await c.ok("state", {}, ts[0])).me.r, "number");
});

test("the skill survey seeds the provisional rating (but not the official one)", async () => {
  const c = await fresh(ADMIN);
  const t = await c.register("surveyed", ip());
  await c.ok("survey", { v: [5, 5, 5, 4, 4, 4] }, t);
  const me = (await c.ok("state", {}, t)).me;
  assert.equal(me.pr, 4.25); assert.equal(me.r, undefined);
});

test("both teams agreeing auto-validates after 15 minutes; any player can reject instead", async () => {
  const c = await fresh(ADMIN);
  const ts = await four(c, ["av1", "av2", "av3", "av4"]);
  for (const t of ts) await c.ok("join", {}, t);
  let s = await Promise.all(ts.map(t => c.ok("state", {}, t)));
  const id = s[0].match.id, a = ts[s.findIndex(x => x.match.side === 0)], b = ts[s.findIndex(x => x.match.side === 1)];
  advance(6 * MIN);
  await c.ok("score", { matchId: id, a: 11, b: 7 }, a);
  await c.ok("score", { matchId: id, a: 11, b: 7 }, b);
  advance(10 * MIN);
  assert.equal((await c.ok("state", {}, a)).match?.status, "playing", "not yet");
  advance(6 * MIN);
  const after = await c.ok("state", {}, b); // any poll finalizes it
  assert.equal(after.match, null);
  assert.equal(after.me.hist.length, 1);

  // second match: a player rejects the submitted score
  const ts2 = await four(c, ["rj1", "rj2", "rj3", "rj4"]);
  for (const t of ts2) await c.ok("join", {}, t);
  s = await Promise.all(ts2.map(t => c.ok("state", {}, t)));
  advance(6 * MIN);
  await c.ok("score", { matchId: s[0].match.id, a: 11, b: 2 }, ts2[0]);
  const r = await c.ok("reject", { matchId: s[0].match.id }, ts2[1]);
  assert.match(r.msg, /admin/);
  assert.equal((await c.ok("state", {}, ts2[0])).match.status, "disputed");
  assert.equal((await c.call("reject", { matchId: s[0].match.id }, ts[0])).status, 400, "outsiders can't reject");
});

test("reliability rises with different partners and opponents, and decays without play", async () => {
  const c = await fresh(ADMIN);
  const t = await c.player("relly", ip());
  const id = await meId(c, t);
  patch(id, { hist: [{ t: Date.now(), m: "x", pt: "p1", op: ["a", "b"], s: [11, 5], d: 0, w: true }] });
  const one = (await c.ok("state", {}, t)).me.rel;
  patch(id, { hist: richHist() });
  const many = (await c.ok("state", {}, t)).me.rel;
  assert.ok(one <= 10 && many === 100, `${one} -> ${many}`);
  advance(200 * DAY);
  const t2 = (await c.ok("login", { username: "relly", password: "secret123" })).token; // tokens last 30 days
  const stale = (await c.ok("state", {}, t2)).me.rel;
  assert.ok(stale < 60 && stale >= 30, "decayed to " + stale);
});

test("certified coaches can give an unrated student a starting rating, once", async () => {
  const c = await fresh(ADMIN);
  const at = (await c.ok("login", { username: "admin", password: ADMIN.ADMIN_PASSWORD })).token;
  const inv = (await c.ok("invite", {}, at)).msg.replace("Invite: ", "");
  const coach = await c.register("coachr", ip()); await c.ok("redeem", { token: inv }, coach);
  const p = await c.player("ratedbycoach", ip()), stranger = await c.player("stranger", ip());
  await c.ok("addSession", { kind: "lesson", ts: Date.now() + HOUR, title: "Eval", price: 0 }, coach);
  await c.ok("book", { sessionId: (await c.ok("state", {}, p)).sessions[0].id }, p);
  await c.ok("attend", { id: (await c.ok("state", {}, p)).bookings[0].id }, coach);
  const pid = await meId(c, p);
  assert.equal((await c.call("rate", { playerId: pid, rating: 7 }, coach)).status, 400);
  await c.ok("rate", { playerId: pid, rating: 3.75 }, coach);
  assert.equal((await c.ok("state", {}, p)).me.r, 3.75);
  assert.equal((await c.call("rate", { playerId: pid, rating: 4 }, coach)).status, 400, "only starting ratings");
  assert.equal((await c.call("rate", { playerId: await meId(c, stranger), rating: 3 }, coach)).status, 400, "only their own students");
  assert.equal((await c.call("rate", { playerId: pid, rating: 3 }, p)).status, 403, "players can't rate");
});

test("XP ceilings no longer cap the rating", async () => {
  const c = await fresh(ADMIN);
  const ts = await four(c, ["cap1", "cap2", "cap3", "cap4"]);
  const ids = await Promise.all(ts.map(t => meId(c, t)));
  ids.forEach((id, i) => patch(id, { r: i < 2 ? 4.0 : 4.0, xp: 1000, hist: [] })); // tier 0 at its 1000 XP ceiling
  const s = st(); s.set("m", { v: JSON.stringify([{ id: "mcap", court: "Court 1", tier: 0, p: ids, start: Date.now(), status: "playing", sub: {} }]), etag: "m3" });
  advance(6 * MIN);
  for (const t of ts) await c.ok("score", { matchId: "mcap", a: 11, b: 3 }, t);
  const me = (await c.ok("state", {}, ts[0])).me;
  assert.ok(me.r > 4.0, "rating rose past the old 1200-Elo ceiling equivalent");
  assert.equal(me.xp, 1000); assert.ok(me.bank > 0, "XP banked instead");
});

test("existing Elo players are converted: 1000 -> 3.000, every 400 Elo = 1.0", async () => {
  const c = await fresh(ADMIN);
  const t = await c.player("oldtimer", ip());
  const id = await meId(c, t);
  const s = st(), u = JSON.parse(s.get("u/" + id).v);
  delete u.pr; delete u.ip; delete u.hist; Object.assign(u, { elo: 1200, w: 4, l: 2 });
  s.set("u/" + id, { v: JSON.stringify(u), etag: "legacy" });
  assert.equal((await c.ok("state", {}, t)).me.r, 3.5);
});

test("games to 15 and 21 count; extended games must end 2 apart", async () => {
  const c = await fresh(ADMIN);
  const ts = await four(c, ["g15a", "g15b", "g15c", "g15d"]);
  for (const t of ts) await c.ok("join", {}, t);
  const id = (await c.ok("state", {}, ts[0])).match.id;
  advance(6 * MIN);
  for (const [a, b, ok] of [[15, 9, 1], [21, 19, 1], [13, 11, 1], [22, 20, 1], [16, 9, 0], [21, 20, 0], [14, 11, 0]]) {
    const r = await c.call("score", { matchId: id, a, b }, ts[0]);
    assert.equal(r.status === 200, !!ok, `${a}-${b}`);
  }
});

test("players directory and profiles: search, history with names, admin hidden", async () => {
  const c = await fresh(ADMIN);
  const ts = await four(c, ["sara", "sam", "tom", "tim"]);
  await playMatch(c, ts, () => [11, 4]);
  const dir = (await c.ok("players", { q: "sa" }, ts[2])).players;
  assert.deepEqual(dir.map(p => p.n).sort(), ["sam", "sara"]);
  assert.ok(!(await c.ok("players", {}, ts[0])).players.some(p => p.n === "admin"));
  const prof = (await c.ok("profile", { id: dir[0].id }, ts[2])).profile;
  assert.equal(prof.hist.length, 1);
  assert.equal(prof.hist[0].op.length, 2);
  assert.ok(prof.hist[0].op.every(n => ["sara", "sam", "tom", "tim"].includes(n)));
  assert.ok(!("h" in prof) && !("salt" in prof) && !("ci" in prof), "no private fields");
  assert.equal((await c.call("profile", { id: "nope" }, ts[0])).status, 404);
  assert.equal((await c.call("players", {}, "")).status, 401, "members only");
});
