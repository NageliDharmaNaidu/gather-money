# Gather setup

Gather stores accounts and money records in SQLite locally (`data/gather.sqlite`) and uses PostgreSQL when `DATABASE_URL` is configured. The production setup uses a persistent hosted database so deployments and idle restarts do not erase records.

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

## Publish on the web for free

The included `render.yaml` deploys a public Node web service on Render's Free plan. For durable account and bill data, Gather uses a separate free PostgreSQL database on Neon. Render's free web services sleep after 15 minutes without traffic and can take about a minute to wake. Neon Free currently includes 1 GB of database storage and 100 compute-unit hours per month; the database scales to zero when idle. These free plans have usage limits and are intended for small hobby projects.

1. Create a PostgreSQL project on [Neon](https://neon.com) using its Free plan. In the connection details, copy the pooled connection string and keep it private.
2. Sign in to [Render](https://render.com), choose **New → Blueprint**, and connect this GitHub repository.
3. When Render asks for `DATABASE_URL`, paste the Neon connection string. Do not put it in GitHub or in browser code.
4. Create the Blueprint. Render will build the app and provide an HTTPS `onrender.com` URL. Open it on a phone or computer, then use **Sign in → Sign up**.

The service refuses to start in production if `DATABASE_URL` is missing, so it cannot silently store production accounts on Render's temporary filesystem. Local development keeps using SQLite when `DATABASE_URL` is blank.

Email/password sign-in works without additional providers. Google sign-in and SMS sign-in remain optional and require separate provider credentials in Render's environment settings. For Google, set `PUBLIC_BASE_URL` to the Render HTTPS URL and add `<PUBLIC_BASE_URL>/api/auth/google/callback` as the OAuth redirect URL in Google Cloud Console. Never commit provider secrets to GitHub.

