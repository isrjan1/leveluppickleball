// Sign in with Google: tokens are signed with a throwaway RSA key and Google's key endpoint is mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { fresh } from "./helpers/harness.mjs";

const CID = "test-client.apps.googleusercontent.com";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, ...r) => String(u).includes("googleapis.com/oauth2/v3/certs") ? Response.json({ keys: [jwk] }) : realFetch(u, ...r);

const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(over = {}, key = privateKey, kid = "k1") {
  const claims = { iss: "https://accounts.google.com", aud: CID, sub: "g-1001", email: "Sam.Player@gmail.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...over };
  const head = b64({ alg: "RS256", typ: "JWT", kid }), body = b64(claims);
  return head + "." + body + "." + createSign("RSA-SHA256").update(head + "." + body).sign(key).toString("base64url");
}
const setup = () => fresh({ ADMIN_PASSWORD: "x-admin-pw", GOOGLE_CLIENT_ID: CID });

test("config tells the page whether Google sign-in is on", async () => {
  const c = await setup();
  assert.equal((await c.ok("config")).google, CID);
  const off = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  assert.equal((await off.ok("config")).google, null);
  assert.equal((await off.call("google", { credential: idToken() })).status, 503);
});

test("new Google account: asks for a username, then creates the player and goes to the survey", async () => {
  const c = await setup(), cred = idToken();
  const first = await c.ok("google", { credential: cred });
  assert.equal(first.needName, true);
  assert.equal(first.email, "sam.player@gmail.com");
  assert.equal(first.suggest, "sam.player");
  assert.equal(first.token, undefined, "no account is created until a username is chosen");

  const done = await c.ok("google", { credential: cred, username: "SamP" });
  const me = (await c.ok("state", {}, done.token)).me;
  assert.equal(me.username, "SamP");
  assert.equal(me.role, "player");
  assert.equal(me.sk, undefined, "no survey yet, so the app shows it next");
  assert.equal(me.g, undefined, "the Google id never goes to the client");
  await c.ok("survey", { v: [3, 3, 3, 3, 3, 3] }, done.token);
});

test("returning Google account signs straight in, even with a different username in the request", async () => {
  const c = await setup(), cred = idToken();
  const t1 = (await c.ok("google", { credential: cred, username: "SamP" })).token;
  const again = await c.ok("google", { credential: idToken(), username: "Other" });
  assert.equal((await c.ok("state", {}, again.token)).me.id, (await c.ok("state", {}, t1)).me.id);
});

test("username rules: taken, reserved and invalid names are refused, then the same Google account can retry", async () => {
  const c = await setup();
  await c.register("taken1");
  const cred = idToken();
  assert.equal((await c.call("google", { credential: cred, username: "Taken1" })).status, 409);
  assert.equal((await c.call("google", { credential: cred, username: "admin" })).status, 409);
  assert.equal((await c.call("google", { credential: cred, username: "a b" })).status, 400);
  assert.equal((await c.call("google", { credential: cred, username: "ab" })).status, 400);
  assert.ok((await c.ok("google", { credential: cred, username: "fresh_name" })).token);
});

test("a Google account has no password: password login with its name fails", async () => {
  const c = await setup();
  await c.ok("google", { credential: idToken(), username: "nopw" });
  for (const pw of ["", "x", "secret123"]) assert.equal((await c.call("login", { username: "nopw", password: pw })).status, 401);
});

test("forged, expired, wrong-audience, unverified and unknown-key tokens are rejected", async () => {
  const c = await setup();
  const bad = [
    idToken({}, other.privateKey),                       // signed by someone else
    idToken({ aud: "someone-else" }),                    // minted for another app
    idToken({ iss: "https://evil.example" }),
    idToken({ exp: Math.floor(Date.now() / 1000) - 10 }),
    idToken({ email_verified: false }),
    idToken({}, privateKey, "unknown-kid"),
    "not.a.jwt", "", undefined,
  ];
  for (const credential of bad) assert.equal((await c.call("google", { credential, username: "evil1" })).status, 401, String(credential).slice(0, 30));
  const tampered = idToken().split("."); tampered[1] = b64({ iss: "https://accounts.google.com", aud: CID, sub: "g-1001", email: "boss@gmail.com", email_verified: true, exp: 9e9 });
  assert.equal((await c.call("google", { credential: tampered.join("."), username: "evil1" })).status, 401);
  assert.equal((await c.call("login", { username: "evil1", password: "x" })).status, 401, "no account was created");
});

test("a disabled Google player cannot sign in", async () => {
  const c = await setup();
  const t = (await c.ok("google", { credential: idToken(), username: "sam2" })).token;
  const admin = (await c.ok("login", { username: "admin", password: "x-admin-pw" })).token;
  await c.ok("setDisabled", { id: (await c.ok("state", {}, t)).me.id, disabled: true }, admin);
  assert.equal((await c.call("google", { credential: idToken() })).status, 403);
});

test("repeated bad tokens from one network are rate limited", async () => {
  const c = await setup();
  let last;
  for (let i = 0; i < 31; i++) last = await c.call("google", { credential: "bad" }, "", "9.9.9.9");
  assert.equal(last.status, 429);
});
