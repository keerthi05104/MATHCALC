# SOLVER — Multiplayer Arithmetic Platform

A full-stack starter implementation for real-time 2-player and 3-player arithmetic games.

## Stack
- React + Vite
- Node.js + Express
- Socket.IO
- Supabase Auth and PostgreSQL (optional until configured)
- Vitest + Supertest for backend tests

## What is implemented
- Four modes: Duo Free Answer, Duo First Correct, Trio Free Answer, Trio First Correct.
- Backend-generated integer arithmetic questions (addition, subtraction, multiplication, exact division).
- Server-authoritative 60-second round timer and scoring.
- Direct typing only; no multiple-choice answers or Submit button.
- Free-answer player-specific question sequences and shared first-correct question sequence.
- Room capacity, ready state, unique room codes, reconnectable socket sessions within a live process.
- Email OTP / Google sign-in UI wired to Supabase client when configured.
- SQL schema and baseline RLS policies for profiles, connections, matches, participants, questions, and attempts.
- Profile dashboard and match-history scaffolding.
- Automated unit/integration tests for question generation and core game logic.

## Requirements
- Node.js 20+
- A Supabase project for persistent profiles/history and authentication (optional for local guest development)
- Google OAuth provider configured in Supabase for Google login.

## Run locally
```bash
npm install
npm run install:all
cp .env.example .env
cp client/.env.example client/.env
npm run dev
```
Frontend: http://localhost:5173
Backend: http://localhost:4000

The server permits local guest play by default (`ALLOW_GUESTS=true`). Set it to `false` for deployment after configuring Supabase authentication. Guest mode is for local development only.

## Environment variables
See root `.env.example` and `client/.env.example`. Never put a Supabase service-role key in frontend environment variables. The frontend only uses the Supabase URL and anon/publishable key.

## Tests
```bash
npm test
npm run build
```
Tests require dependencies installed. The project generator has not executed these commands in this environment; do not treat them as passed until you run them.

## Supabase setup
1. Create a Supabase project.
2. Run `supabase/migrations/001_initial.sql` in the Supabase SQL editor or via Supabase CLI.
3. Enable Google provider in Authentication → Providers and configure Google OAuth client credentials and redirect URLs.
4. Configure allowed redirect URLs to include `http://localhost:5173/auth/callback` and your production frontend URL.
5. Email OTP uses Supabase Auth. Configure SMTP / email provider for reliable production delivery and verify delivery with a real inbox.
6. Add the same Supabase URL and anon key to root backend `.env` and `client/.env`.
7. For production, set `ALLOW_GUESTS=false`, set a strict `CLIENT_ORIGIN`, and configure all secrets through the hosting provider.

## Deploy
- Frontend: Vercel, root directory `client`, build command `npm run build`, output directory `dist`.
- Backend: deploy root Node service to a persistent Node.js host (Render, Railway, Fly.io, etc.) using `npm start`.
- Configure `VITE_API_URL` in `client/.env` to the deployed backend origin.
- Configure `CLIENT_ORIGIN` on backend to the deployed frontend origin.
- Ensure websocket support is enabled on backend host.
- Set environment variables on each host; do not upload `.env` files.

## Important limitations
- This is a functional baseline, not a fully audited production service. Room/game state currently lives in backend memory; restarting the backend clears active rooms. Use a Redis adapter / durable state store for horizontal scaling.
- Match summaries are stored in Supabase only when server Supabase configuration and schema are present. The included schema uses RLS for user-scoped access; server-side persistence needs a server credential or an appropriately scoped authenticated client. This starter does not yet include a full user-profile/friend invitation API.
- Socket authentication uses Supabase access tokens when configured. Guest mode should never be enabled in production.
- Network reconnection can rejoin a room in the same running server process; reconnection across server restart is not supported.
- Exact 60 seconds is enforced by server timestamps and a server timer; clients display server-supplied remaining time. Network delivery can be delayed by normal network latency.
