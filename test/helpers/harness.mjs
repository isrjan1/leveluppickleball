// Test harness: a fresh API module + empty store per test, a controllable clock, and small client helpers.
import { __reset } from "@netlify/blobs";

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
export const advance = ms => { offset += ms; };
export const MIN = 6e4, HOUR = 36e5, DAY = 864e5;

let n = 0;
export async function fresh(env = {}) {
  __reset(); offset = 0;
  for (const k of ["ADMIN_PASSWORD", "SESSION_SECRET"]) delete process.env[k];
  Object.assign(process.env, env);
  const mod = await import(new URL("../../netlify/functions/api.mjs?i=" + ++n, import.meta.url).href);
  const handler = mod.default;
  const call = async (action, data = {}, token = "", ip = "1.1.1.1") => {
    const req = new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ action, ...data }) });
    const r = await handler(req, { ip });
    return { status: r.status, body: await r.json() };
  };
  const ok = async (...a) => { const r = await call(...a); if (r.status !== 200) throw new Error(`${a[0]} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const register = async (name, ip) => (await ok("register", { username: name, password: "secret123" }, "", ip)).token;
  // a ready-to-play player: registered, survey done, checked in (no geofence configured)
  const player = async (name, ip) => { const t = await register(name, ip); await ok("survey", { v: [3, 3, 3, 3, 3, 3] }, t); await ok("checkin", {}, t); return t; };
  return { call, ok, register, player, mod };
}
