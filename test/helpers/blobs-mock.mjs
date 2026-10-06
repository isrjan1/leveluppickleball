// In-memory stand-in for @netlify/blobs with the subset of the API that api.mjs uses,
// including conditional writes (onlyIfMatch / onlyIfNew) so the CAS logic is exercised for real.
const stores = new Map();
let etagSeq = 0;

export function __reset() { stores.clear(); }
export function __dump(name = "the-system") { return stores.get(name) || new Map(); }

export function getStore(opts) {
  const name = typeof opts === "string" ? opts : opts.name;
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  const read = (key, type) => {
    const e = m.get(key);
    if (!e) return null;
    return type === "json" ? JSON.parse(e.v) : e.v;
  };
  const write = (key, str, o = {}) => {
    const e = m.get(key);
    if (o.onlyIfNew && e) return { modified: false };
    if (o.onlyIfMatch && (!e || e.etag !== o.onlyIfMatch)) return { modified: false };
    const etag = "e" + ++etagSeq;
    m.set(key, { v: str, etag });
    return { modified: true, etag };
  };
  return {
    async get(key, o = {}) { return read(key, o.type); },
    async getWithMetadata(key, o = {}) { const e = m.get(key); return e ? { data: read(key, o.type), etag: e.etag, metadata: {} } : null; },
    async set(key, v, o) { return write(key, String(v), o); },
    async setJSON(key, v, o) { return write(key, JSON.stringify(v), o); },
    async delete(key) { m.delete(key); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, etag: m.get(key).etag })) }; },
  };
}
