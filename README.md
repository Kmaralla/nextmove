# NextMove

AI-powered coaching for homework, gaming, and sports.

## Run

1. Copy `.env.example` to `.env`.
2. Replace `your_openai_api_key_here` with your API key.
3. Run `Start NextMove.cmd` or `npm.cmd start`.

Open `http://localhost:4318`.

Run `npm.cmd test` for the isolated API test suite and `npm.cmd run check` for syntax checks. The tests use a local fake AI service and do not consume OpenAI credits.

Optional environment variables: `OPENAI_MODEL` (defaults to `gpt-5.4-mini`), `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_VOICE_MAP`, `RESEND_API_KEY`, and `CONSENT_FROM_EMAIL`.

NextMove is a 13+ public MVP. Under-13 signup, uploads, reports, and chat are blocked. Original uploads are converted in memory, sent for analysis, and never written to NextMove's storage. Only generated coaching reports are saved in `work/nextmove-db.json`.

This MVP is not a legal compliance certification. Obtain privacy and COPPA review before production use with minors.

## Upload and privacy boundaries

- Homework accepts JPG, PNG, WebP, or PDF files up to 20 MB.
- Gaming and sports clips are limited to 30 seconds and 100 MB in the browser. Only up to 12 sampled frames are sent to the server.
- Athlete reference photos are not accepted in the public MVP. Sports users should use jersey number and visible clip context instead.
- Original files and sampled frames are not written to NextMove storage. Generated reports are retained until deleted.
- When read-aloud is used, up to 1,800 characters of coaching text are sent to ElevenLabs to generate temporary audio. NextMove does not save the generated MP3.
- Signup requires date of birth and explicit 13+ Terms/Privacy acceptance.
- Under-13 account creation is blocked. If the operator later supports under-13 users, add verified parental consent, parent access/deletion controls, and legal review before collecting child personal information.

## Deployment

The included `Dockerfile`, `/api/health` endpoint, and `render.yaml` support a single-instance Node deployment with a persistent disk. Configure `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, and set `APP_BASE_URL` to the public HTTPS address. Set `ELEVENLABS_VOICE_ID` for one shared coach voice, or provide `ELEVENLABS_VOICE_MAP` as JSON to assign distinct ElevenLabs voice IDs by coach name.

The current MVP must not be deployed to Vercel as-is: its JSON database and in-memory sessions require a persistent, single-instance server. Before using Vercel or horizontally scaling, migrate users, sessions, and reports to a managed database and object storage. Never commit `.env` or `work/nextmove-db.json`.

## Pre-launch requirements

- Use HTTPS and a verified email sender for account/support messages.
- Complete privacy-policy, terms, COPPA, and child-safety review. The included `public/privacy.html` is a starting notice, not legal approval.
- Keep the service 13+ unless/until a full under-13 compliance program is built.
- Add production moderation, reporting, blocking, retention/deletion controls, monitoring, and backups.
- Replace the local JSON database before serving real users at scale.
