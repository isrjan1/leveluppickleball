// UI smoke test: the real public/index.html in jsdom, with fetch wired straight into the API handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fresh, HOUR } from "./helpers/harness.mjs";

const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick(10)) if (fn()) return;
  throw new Error("timed out waiting for " + what);
}

async function openApp(c, { token, confirmAnswer = true, failFetch = false, html = HTML, url = "https://club.test/" } = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    url, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      if (token) w.localStorage.setItem("pt", token);
      w.confirm = () => w.__confirm;
      w.__confirm = confirmAnswer;
      w.fetch = async (_url, o) => {
        const body = JSON.parse(o.body); calls.push(body.action);
        if (failFetch) throw new TypeError("Failed to fetch");
        const r = await c.call(body.action, body, (o.headers.authorization || "").replace("Bearer ", ""), "198.51.100.9");
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
      };
    },
  });
  const w = dom.window, $ = s => w.document.querySelector(s);
  const click = sel => { const e = typeof sel === "string" ? $(sel) : sel; assert.ok(e, "missing " + sel); e.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); };
  const text = () => w.document.getElementById("app").textContent;
  return { w, $, click, text, calls, close: () => w.close() };
}

test("sign up, take the survey, and land on the Play tab", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const app = await openApp(c);
  app.click("[data-a=mode]");
  app.$("#u").value = "uitester"; app.$("#p").value = "secret123";
  app.click("[data-a=auth]");
  await until(() => app.text().includes("Skill survey"), "survey");
  app.click("[data-a=sv]");
  await until(() => app.text().includes("Open play"), "play tab");
  assert.ok(app.$('nav.tabs [aria-current="page"]'), "current tab is announced");
  assert.ok([...app.w.document.querySelectorAll("input[placeholder]")].every(i => i.getAttribute("aria-label")), "inputs are labelled");
  app.close();
});

test("a double tap sends one request, not two", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const t = await c.player("doubletap", "198.51.100.1");
  const app = await openApp(c, { token: t });
  await until(() => app.text().includes("Open play"), "play tab");
  app.click("[data-a=tab][data-v=quests]");
  const btn = app.$("[data-a=claim]");
  app.click(btn); app.click(btn);
  await until(() => app.text().includes("Done"), "claim result");
  assert.equal(app.calls.filter(a => a === "claim").length, 1);
  assert.ok(!app.$(".toast")?.textContent.startsWith("!"), "no error toast from a second claim");
  app.close();
});

test("coach: cancelling a booked session asks first; one-tap student check-in works", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const at = (await c.ok("login", { username: "admin", password: "x-admin-pw" })).token;
  const inv = (await c.ok("invite", {}, at)).msg.replace("Invite: ", "");
  const ct = await c.register("coachui", "198.51.100.2"); await c.ok("redeem", { token: inv }, ct);
  await c.ok("addSession", { kind: "clinic", ts: Date.now() + HOUR, title: "Drops", price: 500, cap: 4, dur: 60 }, ct);
  const p = await c.player("studentui", "198.51.100.3");
  await c.ok("book", { sessionId: (await c.ok("state", {}, p)).sessions[0].id }, p);

  const app = await openApp(c, { token: ct, confirmAnswer: false });
  await until(() => app.$("[data-v=coach]"), "coach tab");
  app.click("[data-a=tab][data-v=coach]");
  app.click("[data-a=cancelSession]");
  await tick(50);
  assert.equal(app.calls.filter(a => a === "cancelSession").length, 0, "declined confirm sends nothing");

  app.click("[data-a=attend][data-v]");
  await until(() => app.$(".toast")?.textContent.includes("Checked in"), "check-in toast");
  assert.equal((await c.ok("state", {}, p)).me.xp, 40);
  app.close();
});

test("network failure shows a human message instead of 'Failed to fetch'", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const app = await openApp(c, { failFetch: true });
  app.$("#u").value = "someone"; app.$("#p").value = "secret123";
  app.click("[data-a=auth]");
  await until(() => app.$(".toast"), "toast");
  assert.match(app.$(".toast").textContent, /reach the server|offline/);
  app.close();
});

test("admin check-in screen draws the QR code locally and a player can check in with it", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const at = (await c.ok("login", { username: "admin", password: "x-admin-pw" })).token;
  await c.ok("setCfg", { qr: true, courts: "Court 1", rad: 150, minMin: 5, tz: "UTC" }, at);
  // jsdom doesn't fetch script files, so inline the vendored library in place of its <script src>
  const lib = readFileSync(new URL("../public/vendor/qrcode.min.js", import.meta.url), "utf8");
  const html = HTML.replace(/<script src="vendor\/qrcode\.min\.js"[^>]*><\/script>/, () => `<script>${lib}</script>`);
  assert.notEqual(html, HTML, "page loads the vendored QR library");
  assert.ok(!/cdnjs|unpkg|jsdelivr/.test(HTML), "no third-party script hosts");
  const app = await openApp(c, { token: at, html });
  await until(() => app.$("[data-v=admin]"), "admin tab");
  app.click("[data-a=tab][data-v=admin]");
  await until(() => app.$("[data-a=qrOn]"), "show code button");
  app.click("[data-a=qrOn]");
  await until(() => app.$("#qrbox")?.firstChild, "QR drawn");
  const code = app.$("#qrbox").parentElement.querySelector(".big").textContent.trim();
  assert.match(code, /^[A-Z0-9]{8}$/);
  const p = await c.register("qrplayer", "198.51.100.4");
  assert.equal((await c.call("checkin", { code: "WRONG123" }, p)).status, 400);
  await c.ok("checkin", { code }, p);
  assert.equal((await c.ok("state", {}, p)).checked, true);
  app.close();
});

test("first-time player sees the getting-started guide with the next step highlighted", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const app = await openApp(c);
  app.click("[data-a=mode]");
  app.$("#u").value = "rookie"; app.$("#p").value = "secret123";
  app.click("[data-a=auth]");
  await until(() => app.$("[data-a=sv]"), "survey");
  app.click("[data-a=sv]");
  await until(() => app.text().includes("Getting started"), "guide");
  assert.match(app.$(".steps li.now").textContent, /Join an open play/);
  assert.match(app.text(), /NR means not rated yet/);
  app.click("[data-a=hideGuide]");
  await until(() => !app.text().includes("Getting started"), "guide hidden");
  app.close();
});

test("scores are entered from your own team's point of view, whichever side you're on", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const ts = [];
  for (const n of ["lefty", "lefta", "righty", "righta"]) { ts.push(await c.player(n, "198.51.100." + (20 + ts.length))); await c.ok("join", {}, ts.at(-1)); }
  const sides = await Promise.all(ts.map(async t => (await c.ok("state", {}, t)).match.side));
  const rightTok = ts[sides.indexOf(1)], leftTok = ts[sides.indexOf(0)];
  const { advance, MIN } = await import("./helpers/harness.mjs"); advance(6 * MIN);
  const app = await openApp(c, { token: rightTok });
  await until(() => app.$("#sa"), "score inputs");
  app.$("#sa").value = "11"; app.$("#sb").value = "6"; // "we won 11-6" typed by a right-side player
  app.click("[data-a=score]");
  await until(() => app.text().includes("Done on your side. Your team won 11-6"), "own-perspective confirmation");
  assert.match(app.text(), /Entered the score/);
  const left = await c.ok("state", {}, leftTok);
  assert.deepEqual(left.match.agreed, [6, 11], "stored left-team-first: left side lost 6-11");
  app.close();
});

test("no top-level name in the page shadows a browser global (e.g. a function called history)", () => {
  const js = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  const names = new Set([...js.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]));
  for (const m of js.matchAll(/^(?:const|let|var)\s+([^;]+)/gm)) for (const d of m[1].split(/,(?![^(\[{]*[)\]}])/)) { const n = d.trim().match(/^([A-Za-z_$][\w$]*)\s*=/); if (n) names.add(n[1]); }
  const w = new JSDOM("", { url: "https://club.test/" }).window;
  const globals = new Set(["history", "location", "name", "status", "close", "open", "print", "stop", "focus", "blur", "scroll", "top", "parent", "self", "length", "event", "origin", "find", "frames", "opener", "closed", "screen", "navigator", "document", "alert", "confirm", "prompt", "fetch", ...Object.getOwnPropertyNames(w)]);
  w.close();
  const clash = [...names].filter(n => globals.has(n));
  assert.deepEqual(clash, [], "rename these: " + clash.join(", "));
});

test("opening a facility QR link, then logging in, checks the player in", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const at = (await c.ok("login", { username: "admin", password: "x-admin-pw" })).token;
  await c.ok("setCfg", { qr: true, courts: "Court 1", rad: 150, minMin: 5, tz: "UTC" }, at);
  const code = (await c.ok("qrCode", {}, at)).code;
  await c.register("scanner", "198.51.100.40");
  const app = await openApp(c, { url: "https://club.test/?ci=" + code });
  assert.equal(app.w.location.search, "", "code removed from the address bar");
  app.$("#u").value = "scanner"; app.$("#p").value = "secret123";
  app.click("[data-a=auth]");
  await until(() => app.$(".toast")?.textContent.includes("Checked in"), "checked in");
  app.close();
});

test("four players: one enters the score, the others are told exactly what to confirm", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const ts = [];
  for (const n of ["ann", "bob", "cyd", "dan"]) { ts.push(await c.player(n, "198.51.100." + (60 + ts.length))); await c.ok("join", {}, ts.at(-1)); }
  const app0 = await openApp(c, { token: ts[0] });
  await until(() => app0.text().includes("Play your game first"), "locked before min time");
  assert.ok(!app0.$("#sa"), "no score inputs before play time");
  app0.close();
  const { advance, MIN } = await import("./helpers/harness.mjs"); advance(6 * MIN);
  const st = await Promise.all(ts.map(t => c.ok("state", {}, t)));
  const enterer = ts[0], side0 = st[0].match.side;
  const teammate = ts[st.findIndex((x, i) => i > 0 && x.match.side === side0)], opp = ts[st.findIndex(x => x.match.side !== side0)];
  const a = await openApp(c, { token: enterer });
  await until(() => a.text().includes("Step 1: one player enters the final score"), "step 1");
  a.click('[data-a=step][data-v="sa:1"]'); for (let i = 0; i < 4; i++) a.click('[data-a=step][data-v="sb:1"]');
  assert.match(a.$("#spv").textContent, /isn't a valid final score/);
  a.$("#sa").value = "11"; a.$("#sa").dispatchEvent(new a.w.Event("input", { bubbles: true }));
  assert.match(a.$("#spv").textContent, /won 11-4/);
  a.click("[data-a=score]");
  await until(() => a.text().includes("Done on your side"), "entered");
  a.close();
  const b = await openApp(c, { token: opp });
  await until(() => b.text().includes("Step 2: confirm the score"), "step 2 for opponent");
  assert.match(b.text(), /entered: your team lost 4-11/);
  b.click("[data-a=agree]");
  await until(() => b.text().includes("Done on your side"), "confirmed");
  assert.equal((b.text().match(/✓/g) || []).length, 2, "two players show a tick");
  b.close();
  const t = await openApp(c, { token: teammate });
  await until(() => t.text().includes("Yes, we won 11-4"), "teammate sees the same score from their side");
  t.close();
});

test("a game on screen keeps time and unlocks scoring by itself, without a reload", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const ts = [];
  for (const n of ["tick1", "tick2", "tick3", "tick4"]) { ts.push(await c.player(n, "198.51.100." + (80 + ts.length))); await c.ok("join", {}, ts.at(-1)); }
  const app = await openApp(c, { token: ts[0] });
  await until(() => app.text().includes("Playing 0 min"), "fresh game");
  assert.match(app.text(), /Score entry opens in 5 min/);
  const { advance, MIN } = await import("./helpers/harness.mjs");
  advance(7 * MIN); // time passes; nothing about the game itself changes
  app.w.document.dispatchEvent(new app.w.Event("visibilitychange")); // same as a routine background refresh
  await until(() => app.text().includes("Playing 7 min"), "clock moved");
  assert.ok(app.$("#sa"), "score entry unlocked without a reload");
  app.close();
});
