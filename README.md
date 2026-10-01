# Project Suite on the phone

The phone side of the Project Suite relay. It is a static web app for GitHub Pages that you add to
the home screen. It signs in with GitHub through Supabase Auth and shows the suite's Inbox cards
from the work Mac: you can pick an option, comment, look at the images, accept work or send it
back. It also shows agents' final reports (Reports), and you can make a task and start an agent on
it (New): agent, permissions, model and effort are picked from what the Mac allows. Everything in the mailbox is end-to-end encrypted with a key made from the relay
passphrase. Supabase only ever holds ciphertext.

The design and the Mac side live in the suite: `project_management_suite/docs/relay-design.md`
(build tickets R5 and R6; "As built in R5" and "As built in R6" list where they differ from the sketch).

No secrets live here. `config.js` holds the Supabase URL and anon key, which are public by design.
Row-level security and the encryption protect the data.

## Files

| file | what |
|---|---|
| `index.html`, `css/app.css` | the page, styled with the suite's colours |
| `js/app.js` | the screens: sign-in, passphrase, Inbox, Reports, New, Outbox |
| `js/markdown.js` | reports → HTML: escapes everything, then adds only the tags it knows |
| `js/auth.js` | GitHub sign-in (PKCE) and token refresh, plain `fetch` to Supabase Auth |
| `js/mailbox.js` | mailbox rows and blobs, plain `fetch` to PostgREST and Storage |
| `js/sync.js` | the loop: take down rows, decrypt, keep, delete; send the outbox; rekeys |
| `js/store.js` | IndexedDB: session, keys (non-extractable), cards, reports, images, outbox |
| `js/images.js` | phone photos to at most 1600 px JPEG, EXIF dropped |
| `js/relay_crypto.js` | **a copy** of the suite's `public/relay_crypto.js`; never edit it here |
| `sw.js` | caches the app shell only (never data), so it opens offline |
| `config.js` | Supabase URL + anon key (empty until the real project exists) |
| `dev/` | testing only: local stand-in for Supabase, the end-to-end check, icon renderer |

No build step. The files are served as they are.

## Testing locally (no accounts needed)

```sh
npm install          # dev only: playwright-core for the checks
npm run check        # crypto copy == suite's, fixed test vector, service-worker shell list/version
npm run e2e          # ~4 min: the whole thing against the fake mailbox, screenshots in .dev/e2e/
npm run dev          # just the stand-in: prints the app URL and the fake mailbox URL
```

`dev/serve.mjs` starts the suite's own fake mailbox (`test/relay_fake_mailbox.js`) with a proxy in
front of it. The proxy adds CORS, a GitHub stand-in that redirects straight back with a PKCE code,
and the Storage upload and download routes. `dev/e2e.mjs` sets up the relay with the suite's
`scripts/relay.mjs` against it and starts the suite's `server.js` on a free port with throwaway
data and a stub `claude` that never runs an agent (it fails like `/usr/bin/false`, except for one
marked worker run and its `--resume` follow-up, which need a session). It then drives the app at
390×844: sign-in, wrong and right passphrase, cards with images (the Mac's real R4 copies: a check
card with 6 screenshots), Send back with 2 photos landing on the follow-up run, the bucket empty
after delivery, picks moving tickets on the Mac, offline queue, relaunch offline, rekey, a
non-member account. Then R6: the New form's pickers (only allowlisted agents, three modes, no
budget), create + delegate starting the run on the Mac with that agent and mode, its report on the
phone, forged commands (agent not allowed, `bypassPermissions`) and a burst over 10 runs an hour
refused by the Mac. It never touches the suite on :4777.

After changing any shell file, run `node dev/check.mjs --fix` to bump the service worker's
version. Installed apps then offer "Reload". After the suite changes `public/relay_crypto.js`,
copy it over `js/relay_crypto.js` (and `test/relay_crypto_vector.js` over
`dev/relay_crypto_vector.js`).

## Going live (Tine's setup, steps 2, 5 and 7 of the design)

1. Supabase → Auth → Providers: enable GitHub. Auth → URL configuration: add the Pages URL
   (`https://<you>.github.io/pms-relay-phone/`) to the redirect allowlist.
2. Put the project URL and anon key in `config.js`, run `node dev/check.mjs --fix`, push to a public
   repo `pms-relay-phone`, then Settings → Pages → deploy from `main`.
3. On the phone, open the Pages URL, sign in with GitHub, type the four words from
   `node scripts/relay.mjs setup`, then Add to Home Screen.
