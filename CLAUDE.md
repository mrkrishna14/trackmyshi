# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Instagram DM bot that turns shared reels into Google Calendar events. A student shares an internship/job reel to the bot's Instagram professional account (`wantrepreneurs.mov`) via Instagram's native share button. The backend receives the DM through Meta's Instagram Messaging API webhooks, downloads the reel, extracts application deadlines (speech-to-text on audio, OCR on frames, plus the caption), inserts them into the student's Google Calendar with the application link in the event description, and replies in the same DM thread confirming what was added.

There is no mobile app. The product is the Instagram account, this backend, and (later) a one-page Google OAuth site for linking calendars.

## Build order

The project is built one step at a time. Build only what the current step needs.

1. **Webhook logger (current step).** Serve Meta's webhook verification handshake (`GET` with `hub.mode`, `hub.verify_token`, `hub.challenge`; echo the challenge when the token matches) and log every incoming `POST` event in full. The goal is to confirm that a shared reel arrives with a usable media URL. Nothing else is in scope until that's confirmed.
2. **Pipeline.** Download the video, transcribe with Whisper, OCR frames, run LLM extraction of `{company, title, date, time, application_link}`, insert into Google Calendar, and send a confirmation DM via the Send API.
3. **Google OAuth linking page.** Map Instagram user ID to Calendar tokens.
4. **Beta, then Meta app review.** Beta runs with tester accounts first, then public access goes through Meta app review.

## Conventions

- Node.js with Express. Don't add other frameworks, databases, or speculative features unless asked.
- All secrets come from environment variables: the webhook verify token, the Instagram access token, and later API keys and OAuth credentials. Don't hardcode them, and don't add `.env` files to the repo.
- Hosting is Railway, which deploys from the GitHub repo. The server must listen on `process.env.PORT`.

## Meta / Instagram setup (external state)

- The Meta developer app uses the "Instagram API (Unified login)" use case and is in **development mode**. Only accounts added as Instagram Testers (and accepted) can trigger webhooks. The owner's personal account is the test sender.
- The bot account is authenticated with a system-user access token (SUAT) that has `instagram_basic` and `instagram_manage_messages`.
- The webhook callback URL and verify token are configured in the Meta app dashboard. They must match the deployed Railway URL and the verify-token env var.

## Commands

- `npm install`, then `VERIFY_TOKEN=<token> npm start`: runs the server on `PORT` (default 3000).
- Test the handshake: `curl -i "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=12345"` should return `200` with body `12345`.
- There's no test suite or linter yet.

## Code layout

Everything is in `index.js`. `POST /webhook` parses the body as raw text, not with `express.json()`, so malformed bodies still get a 200 and get logged. It sends the 200 *before* logging. The per-message summary reads both `entry[].messaging[]` and `entry[].changes[]` (field `messages`), because Meta uses both shapes.
