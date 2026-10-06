# Pickleball Level Up (v6): club system

Roles: player, certified_coach, admin. Server-side XP/Elo, ranked open-play queue, daily quests,
coach-verified homework and skill badges, tier gates. Data lives in Netlify Blobs.

Deploy: push this folder to GitHub / Netlify. Set env ADMIN_PASSWORD (first admin user is "admin").
Admin tab: set courts, geofence (lat/lng/radius), invite coaches (token) or set roles.

v6.2 notes: passwords are scrypt-hashed server-side (old SHA hashes upgrade on next login), login is rate limited
(8 tries/15 min per name, 40 per IP), admins can disable users. Set the club time zone in Admin so daily quests reset
at local midnight. Tier ceilings (Elo/XP caps until a coach signs off the next badge) are the CAP constant in api.mjs.
Optional env: SESSION_SECRET.
v6.3: ranked-match XP capped at 150/day; same group replaying within 12h earns 50% then 25% XP (flagged for admin); XP past a tier ceiling is banked (max 500) and released with the next badge.
v6.4: rotating facility QR check-in (Admin > Check-in screen; players scan with camera or type the code), coach-published lessons/clinics with prices and capacity, cancellations (2h policy), payment tracking (not processing).
v6.5: prices in pesos; coaches save GCash/e-wallet details, players send a reference number, coach confirms paid.
v6.6: Book tab with 14-day session calendar, 'Coming up' banner, and .ics reminders (alerts 1 day and 2 hours before).
v6.7: session duration (30-240 min), overlap checks for coaches and players, coach schedule grouped by day with booked names.
v6.8 (bug-fix and tuning pass): repeat-group XP damping now matches the docs (1st replay 50%, 2nd+ 25%); disputed matches auto-void after 12h so they can't lock a court; expired queue entries no longer show as "in queue"; invite tokens are no longer burned by coaches/admins; geofence input validated; toast/QR refresh no longer steals input focus or resets the QR toggle; Admin tab loads the user list immediately; service worker no longer caches error responses or per-code URLs; adaptive polling; security headers.
v6.9 (concurrency): every shared record (matches, queue, bookings, sessions, homework, config, users, rate limits) is now written with optimistic compare-and-swap (onlyIfMatch/onlyIfNew) and automatic retry, so simultaneous requests can no longer overwrite each other: double-booking, double XP, duplicate usernames, and lost invite tokens are prevented. Match results are applied by exactly one request. Needs a @netlify/blobs version with conditional writes (the API logs a warning if it detects one without). The session secret is created race-free and cached.

v7.0 (performance pass): admin bootstrap runs once per instance instead of on every login; state polls reuse the already-loaded user and config (2 fewer blob reads per poll); name lookups share in-flight reads; rate-limit checks and hits run in parallel; client skips re-rendering when a poll returns unchanged state (no flicker, less DOM work), pauses polling while offline, and preconnects to font hosts.
