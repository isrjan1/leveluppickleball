const MOCK = new URL("./blobs-mock.mjs", import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (spec === "@netlify/blobs") return { url: MOCK, shortCircuit: true };
  return next(spec, ctx);
}
