// Clubs (v8.3): create, join several, required for open play, ranking by average rating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh } from "./helpers/harness.mjs";

const NAMES = ["owny", "ann", "bob", "cyd", "dee", "coachy"];
const SHARED = "198.51.100.99";
async function setup() {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {}, ID = {};
  for (const [i, n] of NAMES.entries()) { T[n] = await c.player(n, "198.51.100." + (i + 10)); ID[n] = (await c.call("state", {}, T[n], SHARED)).body.me.id; }
  T.admin = (await c.call("login", { username: "admin", password: "x-admin-pw" }, "", SHARED)).body.token;
  const call = (a, b, who) => c.call(a, b, T[who], SHARED);
  assert.equal((await call("setRole", { id: ID.coachy, role: "certified_coach" }, "admin")).status, 200);
  return { c, T, ID, call };
}
const mkClub = async (call, who, name) => (await call("clubCreate", { name, desc: "Friendly club" }, who)).body.club;
const mkOp = (club, extra = {}) => ({ club, title: "Sat open play", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 12, courts: 2, rounds: 2, ...extra });

test("players can create clubs; names are unique and checked", async () => {
  const { call } = await setup();
  const r = await call("clubCreate", { name: "Riverside Dinkers", desc: "Weekend crew" }, "owny");
  assert.equal(r.status, 200);
  assert.equal(r.body.club.n, "Riverside Dinkers");
  assert.equal(r.body.club.isOwner, true);
  assert.equal(r.body.club.m, 1, "the creator is the first member");
  assert.deepEqual(r.body.myClubs.map(c => c.n), ["Riverside Dinkers"]);
  assert.equal((await call("clubCreate", { name: "riverside dinkers" }, "ann")).status, 409, "names are unique, ignoring case");
  assert.equal((await call("clubCreate", { name: "ab" }, "ann")).status, 400, "too short");
  assert.equal((await call("clubCreate", { name: "<script>alert(1)</script>" }, "ann")).status, 400, "odd characters refused");
  for (let i = 1; i <= 5; i++) assert.equal((await call("clubCreate", { name: "Owner club " + i }, "ann")).status, 200);
  assert.equal((await call("clubCreate", { name: "Owner club 6" }, "ann")).status, 400, "up to 5 clubs per owner");
});

test("an open play needs a club the host belongs to", async () => {
  const { call } = await setup();
  const club = await mkClub(call, "owny", "Riverside Dinkers");
  assert.equal((await call("opCreate", mkOp(undefined), "owny")).status, 400, "club is required");
  assert.equal((await call("opCreate", mkOp("nope1234"), "owny")).status, 404, "unknown club");
  assert.equal((await call("opCreate", mkOp(club.id), "ann")).status, 403, "hosts must be members of the club");
  await call("clubJoin", { id: club.id }, "ann");
  const r = await call("opCreate", mkOp(club.id), "ann");
  assert.equal(r.status, 200);
  assert.equal(r.body.od.club, club.id);
  assert.equal(r.body.od.cn, "Riverside Dinkers");
  const list = (await call("state", {}, "owny")).body.ops;
  assert.equal(list[0].cn, "Riverside Dinkers");
  const detail = (await call("clubGet", { id: club.id }, "owny")).body.club;
  assert.equal(detail.ops.length, 1, "the club page lists its open plays");
});

test("players and coaches can join several clubs; leaving, removing and deleting follow the owner rules", async () => {
  const { ID, call } = await setup();
  const a = await mkClub(call, "owny", "Club Alpha"), b = await mkClub(call, "ann", "Club Beta");
  for (const who of ["bob", "coachy"]) for (const c of [a, b]) assert.equal((await call("clubJoin", { id: c.id }, who)).status, 200);
  assert.equal((await call("clubJoin", { id: a.id }, "bob")).status, 400, "can't join twice");
  assert.deepEqual((await call("state", {}, "coachy")).body.myClubs.map(c => c.n).sort(), ["Club Alpha", "Club Beta"]);
  assert.equal((await call("clubLeave", { id: a.id }, "bob")).status, 200);
  assert.equal((await call("clubLeave", { id: a.id }, "owny")).status, 400, "the owner can't leave");
  assert.equal((await call("clubKick", { id: a.id, pid: ID.coachy }, "bob")).status, 403, "only the owner removes players");
  assert.equal((await call("clubKick", { id: a.id, pid: ID.coachy }, "owny")).status, 200);
  assert.equal((await call("clubKick", { id: a.id, pid: ID.owny }, "owny")).status, 400, "the owner can't be removed");
  const op = (await call("opCreate", mkOp(a.id), "owny")).body.od.id;
  assert.equal((await call("clubDelete", { id: a.id }, "owny")).status, 400, "not while open plays are running");
  await call("opCancel", { id: op }, "owny");
  assert.equal((await call("clubDelete", { id: a.id }, "ann")).status, 403);
  assert.equal((await call("clubDelete", { id: a.id }, "owny")).status, 200);
  assert.equal((await call("clubGet", { id: a.id }, "owny")).status, 404);
});

test("club ranking is the average rating of the rated players in each club", async () => {
  const { T, ID, call } = await setup();
  // a coach gives starting ratings to students who attended a session
  const ts = Date.now() + 36e5;
  assert.equal((await call("addSession", { kind: "clinic", ts, title: "Clinic", price: 0, cap: 10, dur: 60 }, "coachy")).status, 200);
  const sid = (await call("state", {}, "coachy")).body.coach.sessions[0].id;
  for (const [n, r] of [["ann", 4], ["bob", 5], ["cyd", 3]]) {
    const bk = await call("book", { sessionId: sid }, n);
    assert.equal(bk.status, 200, JSON.stringify(bk.body));
    const id = bk.body.bookings.find(x => x.sid === sid).id;
    assert.equal((await call("attend", { id }, "coachy")).status, 200);
    assert.equal((await call("rate", { playerId: ID[n], rating: r }, "coachy")).status, 200);
  }
  const hi = await mkClub(call, "ann", "High Club"), lo = await mkClub(call, "cyd", "Low Club"), none = await mkClub(call, "dee", "Unrated Club");
  await call("clubJoin", { id: hi.id }, "bob");
  await call("clubJoin", { id: hi.id }, "dee"); // dee has no rating yet: counts as a player, not in the average
  let rank = (await call("clubs", {}, "owny")).body.clubs;
  assert.deepEqual(rank.map(c => c.n), ["High Club", "Low Club", "Unrated Club"]);
  assert.equal(rank[0].avg, 4.5);
  assert.equal(rank[0].m, 3);
  assert.equal(rank[0].rm, 2);
  assert.equal(rank[1].avg, 3);
  assert.equal(rank[2].avg, null, "no rated players, no average");
  await call("clubJoin", { id: lo.id }, "ann"); // a player in several clubs counts in each: Low = (3 + 4) / 2
  rank = (await call("clubs", {}, "owny")).body.clubs;
  assert.equal(rank.find(c => c.n === "Low Club").avg, 3.5);
  const d = (await call("clubGet", { id: hi.id }, "owny")).body.club;
  assert.deepEqual(d.mem.map(m => m.n), ["bob", "ann", "dee"], "members listed by rating");
  assert.equal((await call("profile", { id: ID.ann }, "owny")).body.profile.clubs.length, 2);
});

test("owners edit a club, set rules, approval and host policy; renaming updates its open plays", async () => {
  const { ID, call } = await setup();
  const club = (await call("clubCreate", { name: "Rules Club", rules: "Be on time.", loc: "Riverside", ap: true, ho: true }, "owny")).body.club;
  assert.equal(club.rules, "Be on time.");
  assert.equal(club.ap, true);
  assert.equal((await call("clubUpdate", { id: club.id, name: "Rules Club" }, "ann")).status, 403, "only the owner edits");
  // approval: a request is not a membership until the owner approves
  const req = await call("clubJoin", { id: club.id }, "ann");
  assert.equal(req.status, 200);
  assert.equal(req.body.club.joined, false);
  assert.equal(req.body.club.requested, true);
  assert.equal((await call("clubJoin", { id: club.id }, "ann")).status, 400, "no duplicate requests");
  assert.equal((await call("gcGet", { kind: "club", id: club.id }, "ann")).status, 403, "requesting is not enough for the chat");
  assert.equal((await call("clubGet", { id: club.id }, "owny")).body.club.rq.length, 1);
  assert.equal((await call("clubGet", { id: club.id }, "ann")).body.club.rq.length, 0, "only managers see requests");
  assert.equal((await call("clubApprove", { id: club.id, pid: ID.ann }, "bob")).status, 403);
  assert.equal((await call("clubDecline", { id: club.id, pid: ID.ann }, "owny")).status, 200);
  await call("clubJoin", { id: club.id }, "ann");
  assert.equal((await call("clubApprove", { id: club.id, pid: ID.ann }, "owny")).status, 200);
  assert.equal((await call("clubGet", { id: club.id }, "ann")).body.club.joined, true, "approved players are members");
  assert.equal((await call("clubGet", { id: club.id }, "ann")).body.club.requested, false);
  // host policy: owner only
  assert.equal((await call("opCreate", mkOp(club.id), "ann")).status, 403, "members can't host when the rules say owner only");
  const op = await call("opCreate", mkOp(club.id), "owny");
  assert.equal(op.status, 200);
  // edit: new name, rules, anyone may host from now on
  const saved = await call("clubUpdate", { id: club.id, name: "Renamed Club", rules: "New rules", ap: false, ho: false }, "owny");
  assert.equal(saved.status, 200);
  assert.equal(saved.body.club.n, "Renamed Club");
  assert.equal(saved.body.club.rules, "New rules");
  assert.equal((await call("state", {}, "owny")).body.ops[0].cn, "Renamed Club", "open plays follow the new name");
  assert.equal((await call("opCreate", mkOp(club.id), "ann")).status, 200);
  assert.equal((await call("clubUpdate", { id: club.id, name: "x" }, "owny")).status, 400);
  await mkClub(call, "bob", "Taken Name");
  assert.equal((await call("clubUpdate", { id: club.id, name: "taken name" }, "owny")).status, 409);
});

test("group chats: one per club for members, one per open play for its host and players", async () => {
  const { call } = await setup();
  const club = await mkClub(call, "owny", "Chat Club");
  await call("clubJoin", { id: club.id }, "ann");
  assert.equal((await call("gcGet", { kind: "club", id: club.id }, "bob")).status, 403, "non-members can't read");
  assert.equal((await call("gcSend", { kind: "club", id: club.id, text: "hi" }, "bob")).status, 403, "or write");
  assert.equal((await call("gcSend", { kind: "club", id: club.id, text: "  " }, "ann")).status, 400, "empty messages refused");
  let r = await call("gcSend", { kind: "club", id: club.id, text: "Who is in on Saturday?" }, "ann");
  assert.equal(r.status, 200);
  assert.equal(r.body.msgs.length, 1);
  assert.equal(r.body.msgs[0].n, "ann");
  const seen = (await call("gcGet", { kind: "club", id: club.id }, "owny")).body.msgs;
  assert.equal(seen[0].x, "Who is in on Saturday?");
  assert.equal((await call("gcGet", { kind: "club", id: club.id, since: seen[0].t }, "owny")).body.same, true, "polling returns nothing new");
  // each open play has its own chat
  const one = (await call("opCreate", mkOp(club.id, { title: "Saturday" }), "owny")).body.od.id;
  const two = (await call("opCreate", mkOp(club.id, { title: "Sunday" }), "owny")).body.od.id;
  assert.equal((await call("gcGet", { kind: "op", id: one }, "ann")).status, 403, "not joined yet");
  await call("opJoin", { id: one }, "ann");
  await call("gcSend", { kind: "op", id: one, text: "Court 1 is booked" }, "owny");
  await call("gcSend", { kind: "op", id: one, text: "Great, see you there" }, "ann");
  assert.equal((await call("gcGet", { kind: "op", id: one }, "ann")).body.msgs.length, 2);
  assert.equal((await call("gcGet", { kind: "op", id: two }, "owny")).body.msgs.length, 0, "chats don't mix");
  await call("opLeave", { id: one }, "ann");
  assert.equal((await call("gcGet", { kind: "op", id: one }, "ann")).status, 403, "leaving takes you out of the chat");
  assert.equal((await call("gcGet", { kind: "team", id: one }, "owny")).status, 400);
  await call("clubLeave", { id: club.id }, "ann");
  assert.equal((await call("gcGet", { kind: "club", id: club.id }, "ann")).status, 403, "leaving the club takes you out of its chat");
});
