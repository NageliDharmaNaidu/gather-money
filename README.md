# Gather setup

Gather stores accounts and money records in a SQLite database at `data/gather.sqlite`. It uses Node.js built-in modules; no package install is required.

## Start the app

1. Install Node.js 24 or later.
2. Run `node server.js` from this folder.
3. Visit http://localhost:3000. Do not open `index.html` directly; sign-in and database features need the app server.
4. Select Sign in, then Sign up to create an email/password account.

The database is initialized automatically the first time the server starts. Each account only reads and changes its own loans and bill splits. Signed-out records stay in the current browser; when you create or log into an account with no records, Gather copies those browser records into that account's database.

## Google sign-in

Google needs an OAuth web application. Set this authorized redirect URI: `http://localhost:3000/api/auth/google/callback`. Put the OAuth client ID and secret in `.env`, then restart the server.

## Phone sign-in

Phone login sends a verification code through Twilio. Configure a Twilio account and sender number, add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` to `.env`, then restart the server. SMS is sent only after someone asks for a code.

The `.env` file and `data/gather.sqlite` are private and excluded from Git. Never put credentials in browser code or share a Twilio auth token. Google and SMS require credentials from those providers.

## Use from other devices

The SQLite database is local to the machine running the server. To use the same accounts across devices, host this app on a private server with HTTPS, set `HOST=0.0.0.0`, `NODE_ENV=production`, and `PUBLIC_BASE_URL` to the HTTPS origin, then register the matching Google callback URL.