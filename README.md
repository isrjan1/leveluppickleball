# Pickleball Level Up (v8): club rating system

Roles: player, certified_coach, admin. Server-side XP/Elo, ranked open-play queue, daily quests,
coach-verified homework and skill badges, tier gates. Data lives in Netlify Blobs.

Deploy: push this folder to GitHub / Netlify. Set env ADMIN_PASSWORD before first use (the first admin user is "admin";
since v7.2 there is no fallback password, so a fresh deploy has no admin until it is set).
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
v7.1: new players (and existing players once) complete a 6-trait skill survey before using the app; the Me tab shows a Skill Trait Gram (radar chart). Self-assessed, stored on the user record, retake allowed every 14 days. It does not change Elo, XP or tiers.
v7.2 (audit pass, see AUDIT.md): no default admin/admin; reserved names (admin, root, staff...) can't be registered; sign-up limit 40/hour per IP so a launch night on club Wi-Fi works; matchmaking fills every free court and, after 10 min, lets a short tier borrow players from one adjacent tier (never Beginner with Advanced); queued players' polls run matchmaking; coach student rosters survive booking-log trimming; logs trim dead records first; quests shuffle daily over 10 drills; existing admin/admin accounts are refused until ADMIN_PASSWORD is set (which then replaces it); admin can reset a forgotten password (temporary password, sessions revoked, lockout cleared); UI blocks double-submits, confirms destructive taps, one-tap student check-in, queue wait time, offline message, accessibility fixes; QR library served from /vendor (no third-party script host); CSP, HSTS and Permissions-Policy headers.

## Tests
`npm install && npm test` (Node 20.6+). 43 tests run against an in-memory Netlify Blobs mock, so no Netlify account is needed:
API scenarios (auth, ranked queue, scoring, disputes, coaching, bookings, quests, concurrency) and jsdom UI smoke tests of public/index.html.

v8.0 (club rating, modelled on how DUPR works): Elo is replaced by a 2.000-8.000 doubles rating. Before each game the two teams' average ratings predict each team's share of points; afterwards the rating moves by actual minus predicted share (so a narrow win can lower it and a close loss raise it), scaled by reliability, capped at 0.200 per game, with results against unrated players counting less and repeat groups (same 3+ players again within 12h) damped like their XP. New players are NR (not rated) with a provisional estimate from the skill survey, or a starting rating from a certified coach, until 3 initialization points or 7 days. Reliability (1-100%) comes from partner/opponent variety over the last 30 games and decays without play. All four players confirm a score; once both teams agree it counts after 15 minutes unless someone rejects it. Games to 11, 15 or 21. Tier ceilings cap XP only. New Players tab (search, club ranking, public profiles with match history). Existing Elo converts on read (1000 -> 3.000, 400 Elo = 1.0). New UI: rating-first design, getting-started guide for new players, scores entered from your own team's point of view.


v8.1 (friends, chat, hosted open play):
- Friends tab: add a player by username (or from their profile), they accept, then you can chat. Remove a friend, decline a request or cancel one you sent at any time; removing a friend deletes the chat. Unread counts show as a badge on the tab. 500 characters per message, 30 messages a minute, last 200 messages kept per chat, 200 friends max.
- Open Play tab: any player can host an open play with a title, description, location, start time, price, max players, number of courts and games per player. Players join and pay the host directly (GCash or another e-wallet, same tracking-not-processing model as coach sessions): they send a reference number, the host marks them paid, and only paid players are scheduled. Free sessions skip payment.
- When the host starts the games the app builds a randomized queue from the paid players: fewest games first, ties and teams split at random, so everyone gets at least the chosen number of games. Games fill the free courts in queue order and never put a player on two courts. Players or the host enter each score; the host can fix a score, take a game off court, or re-randomize the waiting queue. Players who pay late are added to the queue automatically. Ranking inside the open play: wins, then point difference, then points scored.
- Open play results do not change the club rating or XP (those still come only from the confirmed ranked queue).
- Data: friends under fr/<id>, chats under c/<idA>_<idB>, open plays in one "op" list. All writes use the same compare-and-swap helper as the rest of the API. test/social.test.mjs covers the new flows.
