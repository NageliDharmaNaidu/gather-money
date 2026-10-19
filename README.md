# Gather setup

Gather stores accounts and money records in a SQLite database at `data/gather.sqlite`. It uses Node.js built-in modules, so no package install is required.

## Start the app

1. Install Node.js 24 or later.
2. Open a terminal in this folder and run `node server.js`.
3. Visit [http://localhost:3000](http://localhost:3000). Do not open `index.html` directly; the sign-in API and database need the app server.
4. Select **Sign in**, then **Sign up** to create an email/password account.

The database is initialized automatically the first time the server starts. Each account only reads and changes its own loans and bill splits. Signed-out records stay in the browser; if you create or log into an account with no saved records yet, Gather copies those browser records to that account's database.

## Google sign-in

Google needs an OAuth web application from Google Cloud Console. Set this authorized redirect URI:

`http://localhost:3000/api/auth/google/callback`

Put the OAuth client ID and client secret in the matching fields in `.env`, then restart `node server.js`.

## Phone sign-in

Phone login sends a verification code through Twilio. Configure a Twilio account and sender number, put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` in `.env`, and restart the server. SMS is only sent when someone requests a code in the sign-in form.

The `.env` file and `data/gather.sqlite` are private local files and are excluded from Git. Never put credentials in browser code or share a Twilio auth token. Google and SMS setup require accounts and credentials from those providers; Gather cannot create those credentials itself.

## Publish on the web

The included `render.yaml` deploys Gather as a public Render web service and mounts SQLite on a persistent disk so accounts and records survive restarts and deploys. This configuration uses Render's paid web service and 1 GB disk; Render charges for these resources. Free Render web services do not support persistent disks, so they are not suitable for this SQLite database.

1. Push this project to a GitHub repository.
2. Sign in at [Render](https://render.com), choose **New → Blueprint**, and connect the repository.
3. Review the service and disk costs in Render, then create the service. Render will provide an HTTPS `onrender.com` address that opens on phones and computers.
4. Use that URL to sign up. Your account and money records are saved on the persistent database disk.

Google sign-in and SMS sign-in remain optional and require provider credentials in Render's environment settings. For Google, set `PUBLIC_BASE_URL` to the Render HTTPS address and add `<PUBLIC_BASE_URL>/api/auth/google/callback` as the OAuth redirect URL in Google Cloud Console. Add the client ID and secret to Render, never to GitHub.

