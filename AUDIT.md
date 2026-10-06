# Pickleball Level Up: v7.2 audit

Scope: `netlify/functions/api.mjs`, `public/index.html`, `public/sw.js`, `netlify.toml` at v7.1.
Method: read every line, wrote a test suite against v7.1 to confirm each suspected problem actually reproduces,
fixed it, and kept the test so it can't come back. **25 tests, all passing** (`npm test`).

## What was already solid

This is a well-built system for its size, and most of the "hard" things are done right:

- **Concurrency is real.** Every shared record goes through compare-and-swap with retry. The new tests fire
  4 simultaneous joins and 4 simultaneous score confirmations: exactly one match, XP paid exactly once.
- **Server-authoritative game logic.** XP, Elo, tiers and ceilings are computed server-side; the client can't award itself anything.
- **Auth is careful.** scrypt hashing with legacy upgrade, HMAC tokens with a revocation counter, timing-safe
  comparisons, dummy hashing for unknown users, per-name and per-IP lockouts.
- **No XSS found.** Every user-controlled string reaching `innerHTML` goes through `esc()`.
- **Anti-farming design** (daily XP cap, repeat-group damping, tier ceilings with an XP bank) is thoughtful.

## Findings and fixes

| # | Severity | Problem in v7.1 | Fix in v7.2 |
|---|---|---|---|
| 1 | **Critical** | Without `ADMIN_PASSWORD`, the admin account is created as `admin` / `admin`. Whoever finds the deploy first owns it, and existing sites that never changed it stay open. | No fallback password: the admin is only created from `ADMIN_PASSWORD`. Existing `admin`/`admin` accounts are refused at login until `ADMIN_PASSWORD` is set, which then replaces the default and ends its sessions. |
| 2 | **High** | Anyone could register the username `admin` before the real admin logged in. Bootstrap then sees "admin exists" and never creates the real one: the owner is locked out of their own club. | `admin`, `administrator`, `root`, `system`, `support`, `staff` are reserved. |
| 3 | **High** | Players in a thin tier (e.g. only 2 Advanced players) wait forever: matches need 4 from the same tier. | After 10 min, a short tier can borrow from **one** adjacent tier (never Beginner with Advanced). Teams are still balanced by Elo; the match is labelled "mixed". |
| 4 | **High** | Matchmaking only ran on join/score, and made at most one match per tier per run. A freed court or a passed wait time sat idle until someone else acted. | Fills every free court in one pass, and queued players' normal polls run matchmaking (writes nothing when there's nothing to do). |
| 5 | **High** | Sign-ups capped at 10/hour per IP. On launch night everyone signs up on the club Wi-Fi (one IP): player 11 is blocked. | 40/hour per IP. |
| 6 | Medium | Coach-student links came only from the booking log, which is cut at 1,000 entries. Once trimmed, coaches could no longer assess or assign homework to long-time students. | Durable roster on the coach record (`stu`), filled on check-in and backfilled from the log the first time an existing coach opens the app. |
| 7 | Medium | Log trimming dropped the oldest entries even if they were upcoming bookings, unpaid balances or open homework. | Trims dead records first (cancelled, free past bookings, approved homework); upcoming and paid/unpaid priced bookings go only as a last resort. |
| 8 | Medium | No password recovery. A player who forgets their password is locked out for good. | Admin "Reset password": one-time temp password, all that user's sessions revoked, lockout cleared, banner until they set their own. |
| 9 | Medium | Double-tapping a button sent two requests: homework assigned twice, two invite tokens, or a red "Not available" right after a successful claim. | One write at a time; server buttons dim while a request is in flight, with a 20 s timeout so a weak connection can't freeze the app. A QR code scanned before login still checks in afterwards. |
| 10 | Medium | One mis-tap on "Cancel" released every player booked into a session. Same for void match, reset Elo, disable user, make admin. | Confirmation before each (session cancel says how many players lose their spot). |
| 11 | Low | Daily quests alternated between the same two trios forever (`(day + 0/2/4) % 6`). | Day-seeded shuffle over a 10-drill pool; same for the whole club each day. The quest day now follows the same clock as the rest of the API. |
| 12 | Low | QR library loaded from cdnjs with no integrity check: if that file changes, it runs on the admin screen. No CSP. | Library served from `/vendor` (byte-identical to upstream, MIT licence included). Added CSP, HSTS and Permissions-Policy (geolocation only). |
| 13 | Low | Network errors showed "Failed to fetch". | "You're offline" / "Can't reach the server" messages. |
| 14 | Low | Accessibility: toasts not announced, no current-tab marker, placeholder-only inputs, no focus ring. | `role=status` toasts, `aria-current`, auto `aria-label`s, `:focus-visible` outline. |

Also: coaches check students in with **one tap** from the upcoming list (no retyping codes), players see **how long they've been in the queue**, and the coach hint now points to the right tab for booking codes.

## Deploying v7.2

- **Existing deploys:** data is backwards compatible; new fields (`stu`, `mustChange`, `mixed`) are optional. **If the admin still uses `admin`/`admin`, set `ADMIN_PASSWORD` before deploying v7.2**, or admin login will be refused until you do.
- **Fresh deploys:** set `ADMIN_PASSWORD` before first use (it is now required).
- On deploy day the quest list changes once, so a player may see one or two new quests that day.
- The service worker cache name was bumped, so phones pick up the new page on next open.

## Worth considering next (not changed)

- **GPS check-in can be faked** (coordinates come from the phone). QR mode, which already exists, is the strong option; consider making it the default.
- **Daily quests are self-reported**, so they're free XP up to the tier ceiling. Fine as a habit nudge; a coach-verified variant would make them count more.
- **Single-blob lists** (`m`, `q`, `bk`, `ss`, `hw`) are the right call at club scale. Past a few hundred active players, moving bookings and homework to per-record keys would cut contention.
- **Matchmaking on polls** adds a few storage reads per queued player every 15 s. If storage costs ever matter, run it only for the longest-waiting player.
- **Leaderboard and coach list** scan every user record when their 60-second cache expires. Fine up to low thousands of users.
- **Log out** only clears the phone; a "log out everywhere" button would just bump the user's `tv`.
- **Scores** are first-to-11 only; some clubs play to 15 or 21. A per-club setting would be easy.
