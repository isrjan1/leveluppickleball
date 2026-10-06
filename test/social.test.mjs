// Friends, chat and hosted open play (v8.1), run through the same API harness as the other tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh } from "./helpers/harness.mjs";

const NAMES = ["hosty", "ann", "bob", "cyd", "dee", "eve", "fay"];
async function setup() {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {}, ID = {};
  for (const [i, n] of NAMES.entries()) { T[n] = await c.player(n, "198.51.100." + (i + 10)); ID[n] = (await c.call("state", {}, T[n], "198.51.100.99")).body.me.id; }
  const call = (a, b, who) => c.call(a, b, T[who], "198.51.100.99");
  const club = (await call("clubCreate", { name: "Test Club" }, "hosty")).body.club.id; // every open play belongs to a club
  return { c, T, ID, call, club };
}

test("friend requests, accept, remove, and chat only between friends", async () => {
  const { ID, call } = await setup();
  assert.equal((await call("fAdd", { name: "ann" }, "hosty")).body.friends.o.length, 1);
  assert.equal((await call("fAdd", { name: "ann" }, "hosty")).status, 400, "no duplicate requests");
  assert.equal((await call("fAdd", { name: "hosty" }, "hosty")).status, 400, "can't add yourself");
  assert.equal((await call("fAdd", { name: "nobody" }, "hosty")).status, 404);
  assert.equal((await call("send", { id: ID.ann, text: "hi" }, "hosty")).status, 403, "not friends yet");
  assert.equal((await call("state", {}, "ann")).body.friends.i.length, 1);
  assert.equal((await call("fAccept", { id: ID.hosty }, "ann")).body.friends.f.length, 1);
  assert.equal((await call("send", { id: ID.ann, text: "see you Saturday" }, "hosty")).body.msgs.length, 1);
  assert.equal((await call("state", {}, "ann")).body.unread, 1);
  assert.equal((await call("chat", { id: ID.hosty }, "ann")).body.msgs[0].x, "see you Saturday");
  assert.equal((await call("state", {}, "ann")).body.unread, 0, "reading clears unread");
  await call("fRemove", { id: ID.hosty }, "ann");
  assert.equal((await call("send", { id: ID.ann, text: "x" }, "hosty")).status, 403, "removed friends can't chat");
  assert.equal((await call("state", {}, "hosty")).body.friends.f.length, 0);
});

test("two requests crossing become a friendship", async () => {
  const { ID, call } = await setup();
  await call("fAdd", { name: "bob" }, "ann");
  assert.equal((await call("fAdd", { name: "ann" }, "bob")).body.friends.f.length, 1);
  assert.equal((await call("state", {}, "ann")).body.friends.f[0].id, ID.bob);
});

test("open play: join, pay, shuffled queue, scores, ranking", async () => {
  const { ID, call, club } = await setup();
  const mk = { club, title: "Sat open play", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 100, pay: "GCash 0917", cap: 12, courts: 2, rounds: 3 };
  assert.equal((await call("opCreate", { ...mk, pay: "" }, "hosty")).status, 400, "paid sessions need payment details");
  const id = (await call("opCreate", mk, "hosty")).body.od.id;
  assert.equal((await call("opStart", { id }, "hosty")).status, 400, "needs 4 paid players");
  for (const n of NAMES.slice(1)) assert.equal((await call("opJoin", { id }, n)).status, 200);
  assert.equal((await call("opJoin", { id }, "ann")).status, 400, "no double join");
  assert.equal((await call("opPaid", { id, pid: ID.ann }, "ann")).status, 403, "only the host confirms payment");
  for (const n of ["ann", "bob", "cyd", "dee", "eve"]) await call("opPaid", { id, pid: ID[n] }, "hosty");
  assert.equal((await call("opStart", { id }, "ann")).status, 403, "only the host starts");
  let od = (await call("opStart", { id }, "hosty")).body.od;
  assert.equal(od.st, "live");
  const games = new Map(); od.g.forEach(g => g.p.forEach(p => games.set(p, (games.get(p) || 0) + 1)));
  assert.equal(games.size, 6, "only paid players are scheduled");
  assert.ok(!games.has(ID.fay), "unpaid player is not in any game");
  assert.ok([...games.values()].every(n => n >= 3), "everyone gets at least 3 games");
  for (let i = 0; i < 40; i++) {
    od = (await call("opGet", { id }, "hosty")).body.od;
    const on = od.g.filter(g => g.st === "p");
    assert.equal(new Set(on.flatMap(g => g.p)).size, on.length * 4, "nobody on two courts");
    if (!on.length) break;
    assert.equal((await call("opScore", { id, gid: on[0].id, a: 11, b: 8 }, "hosty")).status, 200);
  }
  assert.ok(od.g.every(g => g.st === "d") && od.finished > 0);
  assert.equal(od.rank.reduce((t, r) => t + r.g, 0), od.finished * 4);
  assert.equal((await call("opEnd", { id }, "hosty")).body.od.st, "ended");
});

test("host can add a court and more games; ranked sessions change ratings only when ended, casual never", async () => {
  const { ID, call, club } = await setup();
  const mk = { club, loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 1, rounds: 1 };
  const run = async (mode, title) => {
    const id = (await call("opCreate", { ...mk, title, mode }, "hosty")).body.od.id;
    for (const n of NAMES.slice(1)) await call("opJoin", { id }, n); // free: everyone is in
    return id;
  };
  const rid = await run("ranked", "Ranked night");
  assert.equal((await call("opGet", { id: rid }, "ann")).body.od.mode, "ranked");
  assert.equal((await call("opStart", { id: rid }, "hosty")).status, 400, "ranked needs 8 paid players");
  const cid = await run("casual", "Casual night");
  let od = (await call("opStart", { id: cid }, "hosty")).body.od;
  assert.equal(od.g.filter(g => g.st === "p").length, 1, "one court");
  od = (await call("opCourt", { id: cid }, "hosty")).body.od;
  assert.equal(od.courts, 2);
  assert.equal((await call("opCourt", { id: cid }, "ann")).status, 403, "only the host adds courts");
  const before = od.g.length;
  od = (await call("opMore", { id: cid }, "hosty")).body.od;
  assert.equal(od.rounds, 2); assert.ok(od.g.length > before, "more games queued");
  for (let i = 0; i < 60; i++) {
    od = (await call("opGet", { id: cid }, "hosty")).body.od;
    const g = od.g.find(x => x.st === "p"); if (!g) break;
    await call("opScore", { id: cid, gid: g.id, a: 11, b: 4 }, "hosty");
  }
  await call("opEnd", { id: cid }, "hosty");
  assert.equal((await call("state", {}, "ann")).body.me.pr, 3.5, "casual leaves the rating untouched");
  assert.equal((await call("state", {}, "ann")).body.me.hist.length, 0);
});

test("ranked open play: ratings update once, when the host ends it", async () => {
  const { c, T, call, club } = await setup();
  T.gus = await c.player("gus", "198.51.100.77");
  const all = [...NAMES, "gus"];
  const id = (await call("opCreate", { club, title: "Ranked night", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 2, rounds: 2, mode: "ranked" }, "hosty")).body.od.id;
  for (const n of all.slice(1)) await call("opJoin", { id }, n);
  let od = (await call("opStart", { id }, "hosty")).body.od;
  assert.equal(od.st, "live");
  for (let i = 0; i < 60; i++) {
    od = (await call("opGet", { id }, "hosty")).body.od;
    const g = od.g.find(x => x.st === "p"); if (!g) break;
    await call("opScore", { id, gid: g.id, a: 11, b: 5 }, "hosty");
  }
  const hist = async n => (await call("state", {}, n)).body.me.hist.length;
  for (const n of all) assert.equal(await hist(n), 0, "no rating change while the session is running");
  const r = await call("opEnd", { id }, "hosty");
  assert.equal(r.body.od.applied, true);
  const total = (await Promise.all(all.map(hist))).reduce((t, x) => t + x, 0);
  assert.equal(total, r.body.od.finished * 4, "every finished game counted for all four players");
  assert.equal((await call("opEnd", { id }, "hosty")).status, 400, "can't end twice, so ratings can't be applied twice");
});

test("every player keeps a personal match history across all open plays, casual and ranked", async () => {
  const { ID, call, club } = await setup();
  const play = async (title, mode, who) => {
    const id = (await call("opCreate", { club, title, loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 1, rounds: 1, mode }, "hosty")).body.od.id;
    for (const n of who) await call("opJoin", { id }, n);
    await call("opStart", { id }, "hosty");
    for (let i = 0; i < 20; i++) {
      const od = (await call("opGet", { id }, "hosty")).body.od, g = od.g.find(x => x.st === "p"); if (!g) break;
      await call("opScore", { id, gid: g.id, a: 11, b: 6 }, "hosty");
    }
    return id;
  };
  const first = await play("Casual morning", "casual", ["ann", "bob", "cyd"]);
  assert.equal((await call("profile", { id: ID.ann }, "ann")).body.profile.hist.length, 0, "nothing is logged while the session runs");
  await call("opEnd", { id: first }, "hosty");
  const second = await play("Casual evening", "casual", ["ann", "bob", "cyd"]);
  await call("opEnd", { id: second }, "hosty");
  await call("opEnd", { id: second }, "hosty"); // ending twice must not log twice
  const h = (await call("profile", { id: ID.ann }, "bob")).body.profile.hist;
  assert.equal(h.length, 2, "one game in each open play");
  assert.deepEqual(h.map(x => x.ot).sort(), ["Casual evening", "Casual morning"]);
  assert.ok(h.every(x => x.k === "casual" && x.d == null && x.pt && x.op.length === 2));
  assert.equal((await call("profile", { id: ID.hosty }, "ann")).body.profile.hist.length, 2, "the host's games count too");
});
