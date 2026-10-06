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

async function openApp(c, { token, confirmAnswer = true, failFetch = false } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML, {
    url: "https://club.test/", runScripts: "dangerously", pretendToBeVisual: true,
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
