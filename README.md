# NextMove

AI-powered coaching for homework, gaming, and sports.

## Run

1. Copy `.env.example` to `.env`.
2. Replace `your_openai_api_key_here` with your API key.
3. Run `Start NextMove.cmd` or `npm.cmd start`.

Open `http://localhost:4318`.

Run `npm.cmd test` for the isolated API test suite and `npm.cmd run check` for syntax checks. The tests use a local fake AI service and do not consume OpenAI credits.

Optional environment variables: `OPENAI_MODEL` (defaults to `gpt-5.4-mini`), `RESEND_API_KEY`, and `CONSENT_FROM_EMAIL`.

Without Resend, parent approval links open locally for development. Original uploads are converted in memory, sent for analysis, and never written to NextMove's storage. Only generated coaching reports are saved in `work/nextmove-db.json`.

This MVP is not a legal compliance certification. Obtain privacy and COPPA review before production use with minors.

## Upload and privacy boundaries

- Homework accepts JPG, PNG, WebP, or PDF files up to 20 MB.
- Gaming and sports clips are limited to 30 seconds and 100 MB in the browser. Only up to 12 sampled frames are sent to the server.
- Optional sports reference images are limited to 5 MB and are used only to locate the same athlete in the submitted clip.
- Original files, sampled frames, and reference images are not written to NextMove storage. Generated reports are retained.
- Every learner under 13 requires a parent or guardian email and an explicit approval action. Approval links expire after 48 hours.

## Deployment

The included `Dockerfile`, `/api/health` endpoint, and `render.yaml` support a single-instance Node deployment with a persistent disk. Configure `OPENAI_API_KEY` and set `APP_BASE_URL` to the public HTTPS address.

The current MVP must not be deployed to Vercel as-is: its JSON database and in-memory sessions require a persistent, single-instance server. Before using Vercel or horizontally scaling, migrate users, sessions, consent records, and reports to a managed database and object storage. Never commit `.env` or `work/nextmove-db.json`.

## Pre-launch requirements

- Use HTTPS and a verified parent-consent email sender.
- Complete privacy-policy, terms, COPPA, and child-safety review.
- Add production moderation, reporting, blocking, retention/deletion controls, monitoring, and backups.
- Replace the local JSON database before serving real users at scale.
