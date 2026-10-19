const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const PORT = Number(process.env.PORT || 3000);
const usePostgres = Boolean(process.env.DATABASE_URL);
if (process.env.NODE_ENV === 'production' && !usePostgres) throw new Error('Set DATABASE_URL to a persistent PostgreSQL database before running in production.');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
let sqliteDb = null;
let pgPool = null;

const sqliteSchema = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE COLLATE NOCASE,
    phone TEXT UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    password_salt TEXT,
    google_sub TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS loans (
    id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    lent_at TEXT NOT NULL,
    returned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS splits (
    id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    total REAL NOT NULL CHECK(total > 0),
    created_at TEXT NOT NULL,
    qr_data_url TEXT NOT NULL DEFAULT '',
    people_json TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS phone_codes (
    phone TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`;
const postgresSchema = `
  CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT UNIQUE,
    phone TEXT UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    password_salt TEXT,
    google_sub TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS loans (
    id TEXT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL CHECK(amount > 0),
    lent_at TEXT NOT NULL,
    returned BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS splits (
    id TEXT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    total DOUBLE PRECISION NOT NULL CHECK(total > 0),
    created_at TEXT NOT NULL,
    qr_data_url TEXT NOT NULL DEFAULT '',
    people_json TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS phone_codes (
    phone TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    sent_at BIGINT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    expires_at BIGINT NOT NULL
  );
`;

function postgresSql(sql) { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); }
async function initializeDatabase() {
  if (usePostgres) {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    await pgPool.query(postgresSchema);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    sqliteDb = new DatabaseSync(path.join(DATA_DIR, 'gather.sqlite'));
    sqliteDb.exec(sqliteSchema);
  }
}
async function dbGet(sql, ...params) {
  if (pgPool) return (await pgPool.query(postgresSql(sql), params)).rows[0];
  return sqliteDb.prepare(sql).get(...params);
}
async function dbAll(sql, ...params) {
  if (pgPool) return (await pgPool.query(postgresSql(sql), params)).rows;
  return sqliteDb.prepare(sql).all(...params);
}
async function dbRun(sql, ...params) {
  if (pgPool) return pgPool.query(postgresSql(sql), params);
  return sqliteDb.prepare(sql).run(...params);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const cookieSecure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const cookieName = 'gather_session';
const now = () => Date.now();
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sendJson = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
const sendError = (res, status, error) => sendJson(res, status, { error });
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(value => value.trim()).filter(Boolean).map(value => { const index = value.indexOf('='); return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))]; })); }
async function sessionUser(req) {
  const token = parseCookies(req)[cookieName]; if (!token) return null;
  const row = await dbGet('SELECT u.id, u.email, u.phone, u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', hash(token), now());
  return row || null;
}
async function setSession(res, userId) {
  const token = randomToken(); const expires = now() + 30 * 24 * 60 * 60 * 1000;
  await dbRun('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', hash(token), userId, expires);
  res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${cookieSecure}`);
}
async function clearSession(req, res) {
  const token = parseCookies(req)[cookieName]; if (token) await dbRun('DELETE FROM sessions WHERE token_hash=?', hash(token));
  res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${cookieSecure}`);
}
async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 }); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid request body.'), { status: 400 }); }
}
async function createUser({ email = null, phone = null, displayName = '', password = null, googleSub = null }) {
  const salt = password ? crypto.randomBytes(16).toString('hex') : null;
  const passwordHash = password ? crypto.scryptSync(password, salt, 64).toString('hex') : null;
  if (pgPool) {
    const row = await dbGet('INSERT INTO users(email,phone,display_name,password_hash,password_salt,google_sub) VALUES(?,?,?,?,?,?) RETURNING id', email, phone, displayName, passwordHash, salt, googleSub);
    return Number(row.id);
  }
  const result = await dbRun('INSERT INTO users(email,phone,display_name,password_hash,password_salt,google_sub) VALUES(?,?,?,?,?,?)', email, phone, displayName, passwordHash, salt, googleSub);
  return Number(result.lastInsertRowid);
}
function displayName(email, phone) { return (email || phone || 'Your account').split('@')[0]; }
function publicUser(user) { return { id: Number(user.id), email: user.email, phone: user.phone, displayName: user.display_name }; }
async function authRequired(req, res) { const user = await sessionUser(req); if (!user) { sendError(res, 401, 'Please log in to access your saved records.'); return null; } return user; }
async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/api/session') {
    const user = await sessionUser(req); return sendJson(res, 200, { user: user ? publicUser(user) : null, googleAvailable: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), phoneAvailable: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
    const body = await readBody(req); const email = String(body.email || '').trim().toLowerCase(); const password = String(body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return sendError(res, 400, 'Enter a valid email address.');
    if (password.length < 8) return sendError(res, 400, 'Use a password with at least 8 characters.');
    if (await dbGet('SELECT id FROM users WHERE email=?', email)) return sendError(res, 409, 'An account with this email already exists. Log in instead.');
    const id = await createUser({ email, displayName: displayName(email), password }); await setSession(res, id);
    const user = await dbGet('SELECT id,email,phone,display_name FROM users WHERE id=?', id); return sendJson(res, 201, { user: publicUser(user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req); const email = String(body.email || '').trim().toLowerCase(); const password = String(body.password || '');
    const user = await dbGet('SELECT * FROM users WHERE email=?', email);
    if (!user || !user.password_hash || !user.password_salt) return sendError(res, 401, 'Email or password is incorrect.');
    const actual = crypto.scryptSync(password, user.password_salt, 64); const expected = Buffer.from(user.password_hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return sendError(res, 401, 'Email or password is incorrect.');
    await setSession(res, user.id); return sendJson(res, 200, { user: publicUser(user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') { await clearSession(req, res); return sendJson(res, 200, { ok: true }); }
  if (req.method === 'GET' && url.pathname === '/api/auth/google') return startGoogle(req, res);
  if (req.method === 'GET' && url.pathname === '/api/auth/google/callback') return finishGoogle(req, res, url);
  if (req.method === 'POST' && url.pathname === '/api/auth/phone/send') return sendPhoneCode(req, res);
  if (req.method === 'POST' && url.pathname === '/api/auth/phone/verify') return verifyPhoneCode(req, res);
  if (req.method === 'GET' && url.pathname === '/api/data') {
    const user = await authRequired(req, res); if (!user) return;
    const loanRows = (await dbAll('SELECT id,name,amount,lent_at AS date,returned FROM loans WHERE user_id=? ORDER BY lent_at DESC', user.id)).map(row => ({ ...row, returned: Boolean(row.returned) }));
    const splitRows = (await dbAll('SELECT id,name,total,created_at AS created,qr_data_url AS qr,people_json FROM splits WHERE user_id=? ORDER BY created_at DESC', user.id)).map(row => ({ id: row.id, name: row.name, total: row.total, created: row.created, qr: row.qr, people: JSON.parse(row.people_json) }));
    return sendJson(res, 200, { loans: loanRows, splits: splitRows });
  }
  const deleteRecord = url.pathname.match(/^\/api\/data\/(loans|splits)\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteRecord) {
    const user = await authRequired(req, res); if (!user) return;
    let id; try { id = decodeURIComponent(deleteRecord[2]); } catch { return sendError(res, 400, 'Invalid record id.'); }
    const table = deleteRecord[1] === 'loans' ? 'loans' : 'splits';
    await dbRun(`DELETE FROM ${table} WHERE user_id=? AND id=?`, user.id, id);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/data/sync') {
    const user = await authRequired(req, res); if (!user) return;
    const body = await readBody(req); const loans = Array.isArray(body.loans) ? body.loans : []; const splits = Array.isArray(body.splits) ? body.splits : [];
    if (loans.length > 500 || splits.length > 200) return sendError(res, 413, 'Too many records to sync at once.');
    const loanSql = `INSERT INTO loans(id,user_id,name,amount,lent_at,returned) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,amount=excluded.amount,lent_at=excluded.lent_at,returned=excluded.returned`;
    const splitSql = `INSERT INTO splits(id,user_id,name,total,created_at,qr_data_url,people_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,total=excluded.total,created_at=excluded.created_at,qr_data_url=excluded.qr_data_url,people_json=excluded.people_json`;
    if (pgPool) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        for (const item of loans) { if (item.id && item.name && Number(item.amount) > 0 && item.date) await client.query(postgresSql(loanSql), [String(item.id), user.id, String(item.name).slice(0, 50), Number(item.amount), String(item.date), Boolean(item.returned)]); }
        for (const item of splits) { if (item.id && item.name && Number(item.total) > 0 && Array.isArray(item.people)) await client.query(postgresSql(splitSql), [String(item.id), user.id, String(item.name).slice(0, 60), Number(item.total), String(item.created || new Date().toISOString()), String(item.qr || ''), JSON.stringify(item.people)]); }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } else {
      sqliteDb.exec('BEGIN');
      try {
        const putLoan = sqliteDb.prepare(loanSql); const putSplit = sqliteDb.prepare(splitSql);
        for (const item of loans) { if (item.id && item.name && Number(item.amount) > 0 && item.date) putLoan.run(String(item.id), user.id, String(item.name).slice(0, 50), Number(item.amount), String(item.date), item.returned ? 1 : 0); }
        for (const item of splits) { if (item.id && item.name && Number(item.total) > 0 && Array.isArray(item.people)) putSplit.run(String(item.id), user.id, String(item.name).slice(0, 60), Number(item.total), String(item.created || new Date().toISOString()), String(item.qr || ''), JSON.stringify(item.people)); }
        sqliteDb.exec('COMMIT');
      } catch (error) { sqliteDb.exec('ROLLBACK'); throw error; }
    }
    return sendJson(res, 200, { ok: true });
  }
  sendError(res, 404, 'API route not found.');
}
function googleRedirectUri(req) { return process.env.GOOGLE_REDIRECT_URI || `${process.env.PUBLIC_BASE_URL || `http://${req.headers.host}`}/api/auth/google/callback`; }
async function startGoogle(req, res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return sendError(res, 503, 'Google sign-in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.');
  const state = randomToken(24); await dbRun('INSERT INTO oauth_states(state,expires_at) VALUES(?,?)', state, now() + 10 * 60 * 1000);
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: googleRedirectUri(req), response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }); res.end();
}
async function finishGoogle(req, res, url) {
  const state = url.searchParams.get('state'); const row = state && await dbGet('SELECT state FROM oauth_states WHERE state=? AND expires_at>?', state, now());
  if (!row || !url.searchParams.get('code')) { res.writeHead(302, { Location: '/?auth_error=google' }); res.end(); return; }
  await dbRun('DELETE FROM oauth_states WHERE state=?', state);
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: googleRedirectUri(req), grant_type: 'authorization_code' }) });
    const tokenData = await tokenResponse.json(); if (!tokenResponse.ok) throw new Error('Google token exchange failed.');
    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const profile = await profileResponse.json(); if (!profileResponse.ok || !profile.email || !profile.email_verified) throw new Error('Google account could not be verified.');
    const email = String(profile.email).toLowerCase();
    let user = await dbGet('SELECT * FROM users WHERE google_sub=? OR lower(email)=?', profile.sub, email);
    if (!user) { const id = await createUser({ email, displayName: profile.name || displayName(email), googleSub: profile.sub }); user = await dbGet('SELECT * FROM users WHERE id=?', id); }
    else if (!user.google_sub) { await dbRun('UPDATE users SET google_sub=? WHERE id=?', profile.sub, user.id); }
    await setSession(res, user.id); res.writeHead(302, { Location: '/' }); res.end();
  } catch { res.writeHead(302, { Location: '/?auth_error=google' }); res.end(); }
}
async function sendPhoneCode(req, res) {
  const body = await readBody(req); const phone = String(body.phone || '').replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return sendError(res, 400, 'Enter the phone number with country code, like +919876543210.');
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM) return sendError(res, 503, 'Phone sign-in needs the Twilio account settings in .env.');
  const previous = await dbGet('SELECT sent_at FROM phone_codes WHERE phone=?', phone); if (previous && now() - Number(previous.sent_at) < 60_000) return sendError(res, 429, 'Wait a minute before requesting another code.');
  const code = String(crypto.randomInt(100000, 1000000));
  const form = new URLSearchParams({ To: phone, From: process.env.TWILIO_FROM, Body: `Your Gather verification code is ${code}. It expires in 5 minutes.` });
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  if (!response.ok) return sendError(res, 502, 'Could not send an SMS code. Check your SMS provider settings.');
  await dbRun('INSERT INTO phone_codes(phone,code_hash,expires_at,sent_at,attempts) VALUES(?,?,?,?,0) ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,sent_at=excluded.sent_at,attempts=0', phone, hash(code), now() + 5 * 60_000, now());
  return sendJson(res, 200, { ok: true });
}
async function verifyPhoneCode(req, res) {
  const body = await readBody(req); const phone = String(body.phone || '').replace(/[\s()-]/g, ''); const code = String(body.code || '');
  const row = await dbGet('SELECT * FROM phone_codes WHERE phone=?', phone);
  if (!row || Number(row.expires_at) < now() || Number(row.attempts) >= 5) return sendError(res, 400, 'The code expired. Request a new one.');
  await dbRun('UPDATE phone_codes SET attempts=attempts+1 WHERE phone=?', phone);
  if (hash(code) !== row.code_hash) return sendError(res, 401, 'That verification code is incorrect.');
  await dbRun('DELETE FROM phone_codes WHERE phone=?', phone);
  let user = await dbGet('SELECT * FROM users WHERE phone=?', phone);
  if (!user) { const id = await createUser({ phone, displayName: phone }); user = await dbGet('SELECT * FROM users WHERE id=?', id); }
  await setSession(res, user.id); return sendJson(res, 200, { user: publicUser(user) });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); }
    catch (error) { console.error(error); if (!res.headersSent) sendError(res, error.status || 500, error.status ? error.message : 'Something went wrong.'); else res.end(); }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const safeFiles = new Set(['/', '/index.html', '/styles.css', '/app.js']);
  if (!safeFiles.has(url.pathname)) { res.writeHead(404); res.end('Not found'); return; }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const filePath = path.join(ROOT, file);
  try { const content = fs.readFileSync(filePath); res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)], 'Cache-Control': 'no-cache' }); res.end(content); }
  catch { res.writeHead(404); res.end('Not found'); }
});
initializeDatabase().then(() => {
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Gather is listening on port ${PORT} using ${pgPool ? 'PostgreSQL' : 'SQLite'}`));
}).catch(error => { console.error('Could not initialize the database:', error); process.exitCode = 1; });
process.on('SIGINT', async () => {
  if (pgPool) await pgPool.end(); else sqliteDb?.close();
  server.close(() => process.exit(0));
});

