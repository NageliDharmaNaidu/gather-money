const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const PORT = Number(process.env.PORT || 3000);
// On hosted services, point DATA_DIR at the mounted persistent volume.
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'gather.sqlite'));
db.exec(`
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
`);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const cookieSecure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const cookieName = 'gather_session';
const now = () => Date.now();
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sendJson = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
const sendError = (res, status, error) => sendJson(res, status, { error });
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(value => value.trim()).filter(Boolean).map(value => { const index = value.indexOf('='); return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))]; })); }
function sessionUser(req) {
  const token = parseCookies(req)[cookieName]; if (!token) return null;
  const row = db.prepare('SELECT u.id, u.email, u.phone, u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token), now());
  return row || null;
}
function setSession(res, userId) {
  const token = randomToken(); const expires = now() + 30 * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), userId, expires);
  res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${cookieSecure}`);
}
function clearSession(req, res) {
  const token = parseCookies(req)[cookieName]; if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${cookieSecure}`);
}
async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 }); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid request body.'), { status: 400 }); }
}
function createUser({ email = null, phone = null, displayName = '', password = null }) {
  const salt = password ? crypto.randomBytes(16).toString('hex') : null;
  const passwordHash = password ? crypto.scryptSync(password, salt, 64).toString('hex') : null;
  const result = db.prepare('INSERT INTO users(email,phone,display_name,password_hash,password_salt) VALUES(?,?,?,?,?)').run(email, phone, displayName, passwordHash, salt);
  return Number(result.lastInsertRowid);
}
function displayName(email, phone) { return (email || phone || 'Your account').split('@')[0]; }
function publicUser(user) { return { id: user.id, email: user.email, phone: user.phone, displayName: user.display_name }; }
function authRequired(req, res) { const user = sessionUser(req); if (!user) { sendError(res, 401, 'Please log in to access your saved records.'); return null; } return user; }
async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/api/session') {
    const user = sessionUser(req); return sendJson(res, 200, { user: user ? publicUser(user) : null, googleAvailable: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), phoneAvailable: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
    const body = await readBody(req); const email = String(body.email || '').trim().toLowerCase(); const password = String(body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return sendError(res, 400, 'Enter a valid email address.');
    if (password.length < 8) return sendError(res, 400, 'Use a password with at least 8 characters.');
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return sendError(res, 409, 'An account with this email already exists. Log in instead.');
    const id = createUser({ email, displayName: displayName(email), password }); setSession(res, id);
    const user = db.prepare('SELECT id,email,phone,display_name FROM users WHERE id=?').get(id); return sendJson(res, 201, { user: publicUser(user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req); const email = String(body.email || '').trim().toLowerCase(); const password = String(body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !user.password_hash || !user.password_salt) return sendError(res, 401, 'Email or password is incorrect.');
    const actual = crypto.scryptSync(password, user.password_salt, 64); const expected = Buffer.from(user.password_hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return sendError(res, 401, 'Email or password is incorrect.');
    setSession(res, user.id); return sendJson(res, 200, { user: publicUser(user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') { clearSession(req, res); return sendJson(res, 200, { ok: true }); }
  if (req.method === 'GET' && url.pathname === '/api/auth/google') return startGoogle(req, res);
  if (req.method === 'GET' && url.pathname === '/api/auth/google/callback') return finishGoogle(req, res, url);
  if (req.method === 'POST' && url.pathname === '/api/auth/phone/send') return sendPhoneCode(req, res);
  if (req.method === 'POST' && url.pathname === '/api/auth/phone/verify') return verifyPhoneCode(req, res);
  if (req.method === 'GET' && url.pathname === '/api/data') {
    const user = authRequired(req, res); if (!user) return;
    const loanRows = db.prepare('SELECT id,name,amount,lent_at AS date,returned FROM loans WHERE user_id=? ORDER BY lent_at DESC').all(user.id).map(row => ({ ...row, returned: Boolean(row.returned) }));
    const splitRows = db.prepare('SELECT id,name,total,created_at AS created,qr_data_url AS qr,people_json FROM splits WHERE user_id=? ORDER BY created_at DESC').all(user.id).map(row => ({ id: row.id, name: row.name, total: row.total, created: row.created, qr: row.qr, people: JSON.parse(row.people_json) }));
    return sendJson(res, 200, { loans: loanRows, splits: splitRows });
  }
  const deleteRecord = url.pathname.match(/^\/api\/data\/(loans|splits)\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteRecord) {
    const user = authRequired(req, res); if (!user) return;
    let id; try { id = decodeURIComponent(deleteRecord[2]); } catch { return sendError(res, 400, 'Invalid record id.'); }
    const table = deleteRecord[1] === 'loans' ? 'loans' : 'splits';
    db.prepare(`DELETE FROM ${table} WHERE user_id=? AND id=?`).run(user.id, id);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/data/sync') {
    const user = authRequired(req, res); if (!user) return;
    const body = await readBody(req); const loans = Array.isArray(body.loans) ? body.loans : []; const splits = Array.isArray(body.splits) ? body.splits : [];
    if (loans.length > 500 || splits.length > 200) return sendError(res, 413, 'Too many records to sync at once.');
    const putLoan = db.prepare(`INSERT INTO loans(id,user_id,name,amount,lent_at,returned) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,amount=excluded.amount,lent_at=excluded.lent_at,returned=excluded.returned`);
    const putSplit = db.prepare(`INSERT INTO splits(id,user_id,name,total,created_at,qr_data_url,people_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,total=excluded.total,created_at=excluded.created_at,qr_data_url=excluded.qr_data_url,people_json=excluded.people_json`);
    db.exec('BEGIN');
    try {
      for (const item of loans) { if (item.id && item.name && Number(item.amount) > 0 && item.date) putLoan.run(String(item.id), user.id, String(item.name).slice(0, 50), Number(item.amount), String(item.date), item.returned ? 1 : 0); }
      for (const item of splits) { if (item.id && item.name && Number(item.total) > 0 && Array.isArray(item.people)) putSplit.run(String(item.id), user.id, String(item.name).slice(0, 60), Number(item.total), String(item.created || new Date().toISOString()), String(item.qr || ''), JSON.stringify(item.people)); }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return sendJson(res, 200, { ok: true });
  }
  sendError(res, 404, 'API route not found.');
}
function googleRedirectUri(req) { return process.env.GOOGLE_REDIRECT_URI || `${process.env.PUBLIC_BASE_URL || `http://${req.headers.host}`}/api/auth/google/callback`; }
function startGoogle(req, res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return sendError(res, 503, 'Google sign-in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.');
  const state = randomToken(24); db.prepare('INSERT INTO oauth_states(state,expires_at) VALUES(?,?)').run(state, now() + 10 * 60 * 1000);
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: googleRedirectUri(req), response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }); res.end();
}
async function finishGoogle(req, res, url) {
  const state = url.searchParams.get('state'); const row = state && db.prepare('SELECT state FROM oauth_states WHERE state=? AND expires_at>?').get(state, now());
  if (!row || !url.searchParams.get('code')) { res.writeHead(302, { Location: '/?auth_error=google' }); res.end(); return; }
  db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: googleRedirectUri(req), grant_type: 'authorization_code' }) });
    const tokenData = await tokenResponse.json(); if (!tokenResponse.ok) throw new Error('Google token exchange failed.');
    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const profile = await profileResponse.json(); if (!profileResponse.ok || !profile.email || !profile.email_verified) throw new Error('Google account could not be verified.');
    let user = db.prepare('SELECT * FROM users WHERE google_sub=? OR email=?').get(profile.sub, profile.email);
    if (!user) { const id = Number(db.prepare('INSERT INTO users(email,display_name,google_sub) VALUES(?,?,?)').run(profile.email, profile.name || displayName(profile.email), profile.sub).lastInsertRowid); user = db.prepare('SELECT * FROM users WHERE id=?').get(id); }
    else if (!user.google_sub) { db.prepare('UPDATE users SET google_sub=? WHERE id=?').run(profile.sub, user.id); }
    setSession(res, user.id); res.writeHead(302, { Location: '/' }); res.end();
  } catch { res.writeHead(302, { Location: '/?auth_error=google' }); res.end(); }
}
async function sendPhoneCode(req, res) {
  const body = await readBody(req); const phone = String(body.phone || '').replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return sendError(res, 400, 'Enter the phone number with country code, like +919876543210.');
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM) return sendError(res, 503, 'Phone sign-in needs the Twilio account settings in .env.');
  const previous = db.prepare('SELECT sent_at FROM phone_codes WHERE phone=?').get(phone); if (previous && now() - previous.sent_at < 60_000) return sendError(res, 429, 'Wait a minute before requesting another code.');
  const code = String(crypto.randomInt(100000, 1000000));
  const form = new URLSearchParams({ To: phone, From: process.env.TWILIO_FROM, Body: `Your Gather verification code is ${code}. It expires in 5 minutes.` });
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  if (!response.ok) return sendError(res, 502, 'Could not send an SMS code. Check your SMS provider settings.');
  db.prepare('INSERT INTO phone_codes(phone,code_hash,expires_at,sent_at,attempts) VALUES(?,?,?,?,0) ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,sent_at=excluded.sent_at,attempts=0').run(phone, hash(code), now() + 5 * 60_000, now());
  return sendJson(res, 200, { ok: true });
}
async function verifyPhoneCode(req, res) {
  const body = await readBody(req); const phone = String(body.phone || '').replace(/[\s()-]/g, ''); const code = String(body.code || '');
  const row = db.prepare('SELECT * FROM phone_codes WHERE phone=?').get(phone);
  if (!row || row.expires_at < now() || row.attempts >= 5) return sendError(res, 400, 'The code expired. Request a new one.');
  db.prepare('UPDATE phone_codes SET attempts=attempts+1 WHERE phone=?').run(phone);
  if (hash(code) !== row.code_hash) return sendError(res, 401, 'That verification code is incorrect.');
  db.prepare('DELETE FROM phone_codes WHERE phone=?').run(phone);
  let user = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  if (!user) { const id = createUser({ phone, displayName: phone }); user = db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  setSession(res, user.id); return sendJson(res, 200, { user: publicUser(user) });
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
server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Gather is listening on port ${PORT}`));
process.on('SIGINT', () => { db.close(); server.close(() => process.exit(0)); });

