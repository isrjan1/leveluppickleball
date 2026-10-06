// Loaded with `node --import`: points "@netlify/blobs" at the in-memory mock so tests need no Netlify account.
import { register } from "node:module";
register("./resolve-hook.mjs", import.meta.url);
