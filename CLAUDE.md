# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Due**: an Instagram DM bot that turns shared reels into Google Calendar events. A student shares an internship/job reel to the bot's Instagram account (`wantrepreneurs.mov` while in development) with Instagram's native share button. Meta delivers the DM to `POST /webhook`. The backend fetches the reel, extracts application deadlines from the caption, audio and on-screen text, adds them to the student's Google Calendar with the application link, and replies in the same DM thread. There is no mobile app; the product is the Instagram account, this backend, and a one-page Google OAuth linking site.

## Build modules

The build goes one module at a time, and each module builds only what it needs. After each module, the user gets an exact manual test (which reel to share, what to expect in the DM, the calendar and the `shares` table) before the next module starts.

0. ✅ yt-dlp works from Railway, logged out (Dockerfile).
1. ✅ Ingest hardening: signature check, `shares` table, dedupe on `message.mid`, in-process queue, re-queue on boot.
2. Video to text (built, awaiting the Railway test): yt-dlp fetch, Whisper transcript, Claude-vision OCR of 8 evenly spaced frames, saved with the caption as `shares.bundle`.
3. Extraction (built, awaiting the Railway test): a Claude agent with web search/fetch finds the official application page and deadline; `src/verify.js` checks every quote, date and link in code.
4. Calendar write (built): `src/calendar.js` writes each item's `calendar` entry to the owner's calendar (hardcoded until module 6), with ids stable per student, reel and company.
5. Reply and undo (built): `src/replies.js` holds every DM's wording; `src/instagram.js` sends through Meta's Send API.
6. Google linking: `users` table, signed link codes, re-consent when a token is revoked.
7. Test harness over a 12-reel set.
8. Meta app-review package.

## Rules that shape the code

- **Wrong dates are the one unforgivable error.** A date is calendared only when a quote that really appears in its source (the fetched official page, or the reel's caption/transcript/OCR) states that exact month and day, the year matches or is inferable from the post date, and the date is in the future. **The official page wins** over the creator. A yearless official date that disagrees with the creator, or an official date already past while the creator's is ahead, is a `conflict`, and nothing is calendared. Otherwise the DM says the date couldn't be confirmed.
- **Application links:** the agent searches for the official application page. A link is kept only if it appeared in the agent's search/fetch results or in the reel text, and the page still exists. 403/429 count as existing, since job sites block bots; 404/410 don't. After that come URLs in the caption or OCR text. Never fabricate a URL, and never use one whose source (`web`, `caption`, `ocr`, `transcript`) can't be named in the logs.
- `POST /webhook` responds 200 before doing anything. All work runs off the queue.
- Every failure path ends in an honest DM (from module 5 on) and a `failure_reason` on the share row. A bad reel never crashes the server.
- Use only the Meta permissions `instagram_basic` and `instagram_manage_messages`. If a feature seems to need another permission, stop and ask; don't add it.
- Transcription and the LLM each sit behind one function with a fixed input/output contract (vendor isolation).
- No ORM, no migrations framework, no feature flags, no admin panel, no settings. Prefer deleting code over adding config.
- Secrets come only from env vars.

## Commands

- `npm start` runs the server. It needs `DATABASE_URL` and `APP_SECRET`, plus `VERIFY_TOKEN` for the handshake. Without `APP_SECRET`, every POST is dropped.
- `node scripts/google-auth.js <oauth-client.json>` is the one-time Google sign-in for the owner's calendar (Desktop OAuth client, scope `calendar.events`). It saves the refresh token to `~/.config/due/google-refresh-token` and never prints it. Railway needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`. The OAuth app must be "In production", because refresh tokens issued in Testing mode expire after 7 days.
- `npm test` runs the pure unit tests.
- `TEST_DATABASE_URL=postgres://localhost/due_test npm test` also runs the DB and server integration tests. Those truncate and drop tables, so `test/helpers.js` refuses any non-localhost URL. Local Postgres is Homebrew `postgresql@17`.
- Tests never touch the network: `test/bin/yt-dlp` is a stub put first on `PATH` (`STUB_YTDLP=ok|private`), Whisper is tested with a fake global `fetch`, and `ocr`/`buildBundle` take their client and dependencies as arguments. The media tests run the real ffmpeg on a generated clip.
- Run a single file with `node --test test/webhook.test.js`, or a single test with `node --test --test-name-pattern="dedupes" test/db.test.js`.

## Architecture

- **Request path:** `index.js` reads `POST /webhook` as raw bytes, because the signature covers the exact bytes Meta sent. It responds 200, then checks `X-Hub-Signature-256` (`src/webhook.js`).
- **Parsing:** `parseEvents` reduces the body to `reel` and `text` events. It reads only `entry[].messaging[]`, which is what real payloads use, and drops echoes, deletions, reads and reactions.
- **Recording:** reels go to `pipeline.receiveReel`, which inserts into `shares`. `ON CONFLICT (mid) DO NOTHING` absorbs Meta's redeliveries. New shares are queued for `processShare`.
- **The table is the source of truth.** `src/queue.js` is in-memory, with concurrency 2. On boot, `requeueInProgress` re-queues shares that are partway through the pipeline and less than 24 hours old; the Send API only allows replies within 24h.
- **Schema:** `src/db.js` applies `schema.sql` on every boot, so every statement there must be idempotent. Add columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and never edit `shares` destructively.
- **Logging:** each status change goes through `db.setStatus`, which logs `share mid=… sender=… status=…`. Logs and the `shares` table are the debugging surface. Don't log full webhook bodies, because they contain student captions.
- **Stages:** `processShare` reads the row and runs the stage for its current status, so a re-queued share resumes where it stopped. The fetch stage (`buildBundle` in `src/pipeline.js`) works in a temp dir that's always deleted. A failed step leaves its part of the bundle `null` and adds a reason, and the share still moves on: a failed fetch still gives a caption-only bundle. `failure_reason` then holds the comma-joined reasons even though the status is `fetched`. Reasons: `reel_private_or_deleted`, `fetch_login_required` (Instagram says this for both private reels and blocked requests), `fetch_failed`, `transcribe_failed`, `ocr_failed`. An unexpected throw marks the share `failed` with `internal_error`.
- **Extraction:** `src/extract.js` runs one agent request (resuming on `pause_turn`) with `web_search`/`web_fetch` server tools and a strict `submit_result` tool. Structured outputs aren't used because they can't be combined with web-search citations. It returns the raw claims plus evidence: the text of all tool results, and the fetched pages' text. `src/verify.js` turns the claims into `shares.extraction.items[]` with `deadline`, `date_status` (`verified_official`, `verified_creator`, `conflict`, `passed`, `unconfirmed`, `none`), `link`, `note` and `calendar`. `calendar` is what module 4 writes: `{kind:"deadline"}` for a verified date, `{kind:"reminder"}` three days after the share (postings that close when filled; user decision), or `null`. A reminder needs: no date anywhere, a link to a specific posting (not a careers homepage, no "closed" in the path) and `posting_status: "open"` from the agent. Postings whose `cycle` (e.g. "Summer 2026") has already ended get no reminder: old reels advertise past seasons. When the agent finds a current posting for an old reel, `updated_from` holds the reel's ended season (from `reel_cycle`), so the reply and the event can say so. The model's raw answer is kept under `claimed`. Agent failures fail the share with `extraction_failed` or `extraction_invalid`, keeping the earlier reasons.
- **Calendar:** the stage re-checks each entry when writing (`freshEntry`), because a re-queued share can be calendared later than it was extracted. Deadlines are a 30-minute block ending at the stated time, or at 23:59 in the calendar's timezone (read from `events.list`, so no extra scope). Reminders are all-day "Apply soon" events. A 409 on insert means the event id exists (a retry, a re-share, or a deleted event), so the event is updated with `PUT ... status: confirmed`. Written events go to `shares.event_ids`. A revoked token is `google_reauth_needed`; anything else is `calendar_failed`.
- **Replies:** after `calendared`, the reply stage sends `shareReply` and stores the bot's message id as `reply_mid`. Every failure goes through `fail()`, which records the reason and sends `failureReply`. Text messages are deduped in the `texts` table. "undo" (sent as a reply to the bot's message, or plain) deletes that share's events and marks it `undone`; anything else gets one help line. The Send API is `POST graph.facebook.com/v24.0/{IG_ACCOUNT_ID}/messages` with a system-user token (`IG_ACCESS_TOKEN`, from the Meta dashboard's Instagram "Generate token"; usually non-expiring). That token also carries ads and publishing scopes from Meta's preset, which the code never uses; trim them before App Review.
- **Vendors:** `src/transcribe.js` is the only OpenAI code (`whisper-1`, plain `fetch`). `src/ocr.js` (structured JSON output, low effort) and `src/extract.js` (medium effort, web tools) are the only Anthropic code. Both use `claude-sonnet-5-5` with the server-side refusal fallback. Each validates the response and throws rather than guessing.
- **Real reel payload:** `attachments[{type:"ig_reel", payload:{url, title, reel_video_id}}]`. `url` is the public reel *page*, not a video file. `title` is the caption. yt-dlp returns the creator's handle in `channel`; `uploader` is empty.

## Deployment (Railway)

- Production runs on Railway project `modest-hope`, service `trackmyshi` (https://trackmyshi-production.up.railway.app), under co-founder Jake's account. Jake's own Instagram automation runs elsewhere; never touch it.
- Railway builds from the `Dockerfile`, which pins Node 24, ffmpeg and a checksum-verified yt-dlp binary.
- Pushing to GitHub hasn't been triggering deploys. Deploy an exact commit with `git archive <sha> | tar -x -C <dir>`, then `railway up --service trackmyshi --ci` from that directory.
- Access is through a project token in `RAILWAY_TOKEN`. It supports `up`, `logs`, `variables` and `deployment list`, but **not** `railway ssh` or `railway connect`.

## Meta setup (external state)

- The Meta app uses "Instagram API (Unified login)", a configuration built on Facebook Login for Business. It's in **development mode**, so only accepted Instagram Testers trigger webhooks.
- `APP_SECRET` is the app secret from App settings → Basic.
