const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
const safeRead = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let loans = safeRead('gather-loans', []);
let splits = safeRead('gather-splits', []);
let qrImage = '';
let activeSplitId = null;
let toastTimer;
let currentUser = null;
let remoteSaveTimer = null;
let appServerAvailable = false;
let googleAvailable = false;

function save() {
  try { localStorage.setItem('gather-loans', JSON.stringify(loans)); localStorage.setItem('gather-splits', JSON.stringify(splits)); }
  catch { showToast('Browser storage is full. Try a smaller QR image.'); }
  renderDashboard();
  if (currentUser) { clearTimeout(remoteSaveTimer); remoteSaveTimer = setTimeout(syncToDatabase, 350); }
}
function showToast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2600); }
function localDateTime() { const now = new Date(); const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000); return local.toISOString().slice(0, 16); }
function initials(name) { return name.trim().split(/\s+/).map(part => part[0] || '').join('').slice(0, 2).toUpperCase() || '?'; }
function renderDashboard() {
  const lentPending = loans.filter(item => !item.returned).reduce((sum, item) => sum + Number(item.amount), 0);
  const splitPending = splits.reduce((sum, split) => sum + split.people.filter(person => !person.paid).reduce((part, person) => part + Number(person.share ?? (split.total / split.people.length)), 0), 0);
  $('#dashboard-collect').textContent = money(lentPending + splitPending);
  $('#dashboard-people').textContent = loans.filter(item => !item.returned).length;
  $('#dashboard-bills').textContent = splits.length;
  const entries = [
    ...loans.map(item => ({ type: 'lend', id: item.id, label: `Money lent to ${item.name}`, sub: new Date(item.date).toLocaleDateString(undefined, { dateStyle: 'medium' }), amount: item.amount, state: item.returned ? 'Returned' : 'Pending', date: new Date(item.date).getTime() })),
    ...splits.map(item => ({ type: 'split', id: item.id, label: item.name, sub: `${item.people.length} people · ${new Date(item.created).toLocaleDateString(undefined, { dateStyle: 'medium' })}`, amount: item.total, state: `${item.people.filter(person => person.paid).length}/${item.people.length} paid`, date: new Date(item.created).getTime() }))
  ].sort((a, b) => b.date - a.date).slice(0, 5);
  const activity = $('#dashboard-activity');
  if (!activity) return;
  if (!entries.length) { activity.innerHTML = '<div class="empty-record"><span class="empty-record-icon">✳</span><div><strong>Your activity will appear here</strong><p>Add a lending record or create your first group bill.</p></div></div>'; return; }
  activity.innerHTML = entries.map(item => `<button class="dashboard-activity-row" data-activity-type="${item.type}" data-activity-id="${item.id}"><span class="quick-symbol ${item.type === 'lend' ? 'quick-lend' : 'quick-split'}">${item.type === 'lend' ? '↗' : '⌁'}</span><span class="record-main"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.sub)}</small></span><span class="dash-row-amount">${money(item.amount)}<small>${escapeHtml(item.state)}</small></span><b>→</b></button>`).join('');
  activity.querySelectorAll('[data-activity-type="lend"]').forEach(button => button.addEventListener('click', () => setPage('lend')));
  activity.querySelectorAll('[data-activity-type="split"]').forEach(button => button.addEventListener('click', () => { const split = splits.find(item => item.id === button.dataset.activityId); setPage('split'); renderSplitResult(split); $('#split-result-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
}
function setPage(page) {
  const isSplit = page === 'split'; const isDashboard = page === 'dashboard';
  $('#dashboard-view').hidden = !isDashboard;
  $('#lend-view').hidden = isSplit;
  $('#lend-view').hidden = isSplit || isDashboard;
  $('#split-view').hidden = !isSplit;
  $$('.nav-item[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  const title = isSplit ? 'Split bill' : isDashboard ? 'Dashboard' : 'Lend person';
  $('#page-title').textContent = title;
  $('#breadcrumb-page').textContent = title;
  $('#page-subtitle').textContent = isSplit ? 'Add a bill, add the group, and keep track of who has paid.' : isDashboard ? 'Your personal money space, all in one place.' : 'Keep a clear note of money you’ve lent and when it happened.';
  $('#sidebar').classList.remove('open');
}
$$('.nav-item[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page)));
$$('[data-go]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.go)));
$('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

function renderLoans() {
  const pending = loans.filter(item => !item.returned);
  $('#pending-count').textContent = pending.length;
  $('#loan-total').textContent = `${money(pending.reduce((sum, item) => sum + Number(item.amount), 0))} pending`;
  const list = $('#loan-records');
  if (!loans.length) {
    list.innerHTML = '<div class="empty-record"><span class="empty-record-icon">↗</span><div><strong>No lending records yet</strong><p>When you lend someone money, add their name, amount, and date here.</p></div></div>';
    return;
  }
  list.innerHTML = loans.map(item => `<article class="record-row"><span class="person-mark">${escapeHtml(initials(item.name))}</span><div class="record-main"><strong>${escapeHtml(item.name)}</strong><small>${new Date(item.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</small></div><div class="record-amount">${money(item.amount)}<small>${item.returned ? 'Returned' : 'Pending'}</small></div><button class="record-action ${item.returned ? 'returned' : ''}" data-return="${item.id}">${item.returned ? '✓ Returned' : 'Mark returned'}</button></article>`).join('');
  list.querySelectorAll('[data-return]').forEach(button => button.addEventListener('click', () => {
    const loan = loans.find(item => item.id === button.dataset.return); loan.returned = !loan.returned; save(); renderLoans(); showToast(loan.returned ? `Marked ${loan.name} as returned.` : `Moved ${loan.name} back to pending.`);
  }));
}

$('#lend-datetime').value = localDateTime();
$('#lend-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#person-name').value.trim(); const amount = Number($('#lend-amount').value); const date = new Date($('#lend-datetime').value);
  if (!name || !Number.isFinite(amount) || amount <= 0 || Number.isNaN(date.getTime())) { showToast('Please enter a name, amount, and valid date and time.'); return; }
  loans.unshift({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name, amount, date: date.toISOString(), returned: false });
  save(); renderLoans(); event.target.reset(); $('#lend-datetime').value = localDateTime(); showToast(`Saved ${money(amount)} lent to ${name}.`);
});

function renderPeopleInputs(count, existing = []) {
  const container = $('#people-inputs');
  container.innerHTML = Array.from({ length: count }, (_, index) => {
    const value = existing[index] ?? '';
    return `<label class="person-input-row"><span class="person-input-index">${index + 1}</span><input data-person-index="${index}" maxlength="40" value="${escapeHtml(value)}" placeholder="Person ${index + 1} (optional)" aria-label="Person ${index + 1} name, optional"></label>`;
  }).join('');
  $('#people-count-label').textContent = `${count} ${count === 1 ? 'person' : 'people'}`;
}
function currentPeople() { return $$('#people-inputs input').map(input => input.value.trim()); }
function validCount(value) { const count = Math.floor(Number(value)); return Number.isFinite(count) ? Math.max(1, Math.min(100, count)) : 1; }
$('#people-count').addEventListener('change', event => {
  const oldNames = currentPeople(); const count = validCount(event.target.value); event.target.value = count; renderPeopleInputs(count, oldNames);
});
$('#people-count').addEventListener('blur', event => {
  const oldNames = currentPeople(); const count = validCount(event.target.value); event.target.value = count; renderPeopleInputs(count, oldNames);
});
renderPeopleInputs(2);

function amountCandidates(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parse = line => [...line.matchAll(/(?:₹|rs\.?|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+\.[0-9]{1,2}|[0-9]{2,6})/gi)].map(match => Number(match[1].replace(/,/g, ''))).filter(value => value > 0 && value < 100000000);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/grand\s*total|amount\s*due|total\s*due|\btotal\b|payable|net\s*amount/i.test(lines[index])) {
      const candidates = parse(lines[index]); if (candidates.length) return candidates.at(-1);
    }
  }
  const all = lines.flatMap(parse);
  return all.length ? all.at(-1) : null;
}
$('#receipt-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  $('#receipt-label').textContent = file.name.length > 20 ? `${file.name.slice(0, 18)}…` : file.name;
  $('#receipt-status').textContent = 'Reading receipt…';
  if (!file.type.startsWith('image/')) { $('#receipt-status').textContent = 'Upload a receipt photo (JPG or PNG).'; return; }
  if (typeof Tesseract === 'undefined') { $('#receipt-status').textContent = 'Receipt reader unavailable. Enter the total above.'; return; }
  try {
    const result = await Tesseract.recognize(file, 'eng', { logger: progress => { if (progress.status === 'recognizing text') $('#receipt-status').textContent = `Reading receipt… ${Math.round(progress.progress * 100)}%`; } });
    const detected = amountCandidates(result.data.text);
    if (detected) { $('#bill-total').value = detected.toFixed(2); $('#receipt-status').textContent = `Possible total found: ${money(detected)}. Please check it.`; }
    else { $('#receipt-status').textContent = 'Could not find a total. Enter it above.'; }
  } catch { $('#receipt-status').textContent = 'Could not read this image. Enter the total above.'; }
});

$('#payment-qr').addEventListener('change', event => {
  const file = event.target.files?.[0]; if (!file) return;
  if (!file.type.startsWith('image/')) { showToast('Choose an image of your bank or UPI QR code.'); return; }
  if (file.size > 2 * 1024 * 1024) { showToast('Please use a QR image smaller than 2 MB.'); return; }
  const reader = new FileReader();
  reader.onload = () => { qrImage = String(reader.result); $('#qr-file-label').textContent = '✓ QR added'; showToast('Payment QR added to this bill.'); };
  reader.readAsDataURL(file);
});

function renderSplitResult(split) {
  activeSplitId = split.id;
  const card = $('#split-result-card'); card.hidden = false;
  const cents = Math.round(split.total * 100); const baseShare = Math.floor(cents / split.people.length); const remainder = cents - baseShare * split.people.length;
  split.people.forEach((person, index) => { person.share = (baseShare + (index < remainder ? 1 : 0)) / 100; });
  const paid = split.people.filter(person => person.paid).length;
  $('#result-bill-name').textContent = split.name;
  $('#result-bill-meta').textContent = `${split.people.length} ${split.people.length === 1 ? 'person' : 'people'} · equal split`;
  $('#result-total').textContent = money(split.total);
  $('#share-label').textContent = remainder ? 'Per-person shares' : 'Each person pays';
  $('#each-share').textContent = remainder ? `${money(baseShare / 100)}–${money((baseShare + 1) / 100)}` : money(baseShare / 100);
  $('#share-remainder').textContent = remainder ? `First ${remainder} ${remainder === 1 ? 'share gets' : 'shares get'} 1 paisa extra each to match the total.` : 'Everyone pays the same amount.';
  $('#paid-count').textContent = `${paid} of ${split.people.length} paid`;
  $('#split-people-list').innerHTML = split.people.map(person => `<div class="split-person-row"><input class="paid-check" type="checkbox" data-paid="${person.id}" ${person.paid ? 'checked' : ''} aria-label="Mark ${escapeHtml(person.name)} as paid"><span class="person-mark">${escapeHtml(initials(person.name))}</span><div class="record-main"><strong>${escapeHtml(person.name)}</strong><small>${person.paid ? 'Paid' : 'Still to pay'}</small></div><div class="record-amount">${money(person.share)}<small>their share</small></div></div>`).join('');
  const qr = $('#result-qr-wrap');
  qr.innerHTML = split.qr ? `<img src="${split.qr}" alt="Payment QR code"><span><strong>Payment QR attached</strong><small>Friends can scan to pay you</small></span>` : '<span><strong>No payment QR attached</strong><small>You can add one to your next bill</small></span>';
  $('#split-people-list').querySelectorAll('[data-paid]').forEach(input => input.addEventListener('change', () => {
    const person = split.people.find(item => item.id === input.dataset.paid); person.paid = input.checked; save(); renderSplitResult(split); renderHistory(); showToast(`${person.name} marked ${person.paid ? 'paid' : 'unpaid'}.`);
  }));
  save();
}
function renderHistory() {
  const list = $('#split-history');
  if (!splits.length) { list.innerHTML = '<div class="empty-record"><span class="empty-record-icon">⌁</span><div><strong>No group bills yet</strong><p>Your created bill splits will appear here.</p></div></div>'; return; }
  list.innerHTML = splits.map(split => { const paid = split.people.filter(person => person.paid).length; return `<div class="history-row"><span class="heading-symbol green">⌁</span><div class="record-main"><strong>${escapeHtml(split.name)}</strong><small>${split.people.length} ${split.people.length === 1 ? 'person' : 'people'} · ${new Date(split.created).toLocaleDateString()}</small></div><span class="history-progress">${paid}/${split.people.length} paid</span><button class="history-open" data-open-split="${split.id}">Open</button></div>`; }).join('');
  list.querySelectorAll('[data-open-split]').forEach(button => button.addEventListener('click', () => { const split = splits.find(item => item.id === button.dataset.openSplit); renderSplitResult(split); $('#split-result-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
}
$('#split-form').addEventListener('submit', event => {
  event.preventDefault();
  const rawCount = $('#people-count').value;
  if (!rawCount || !Number.isInteger(Number(rawCount)) || Number(rawCount) < 1) { showToast('Enter a whole number of people.'); return; }
  const count = validCount(rawCount); const names = currentPeople();
  if (names.length !== count) { showToast('Check the number of people in the split.'); return; }
  const total = Number($('#bill-total').value); if (!Number.isFinite(total) || total <= 0) { showToast('Enter a bill total greater than zero.'); return; }
  const split = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: $('#bill-name').value.trim(), total, created: new Date().toISOString(), qr: qrImage, people: names.map((name, index) => ({ id: `${Date.now()}-${index}`, name: name || `Person ${index + 1}`, paid: false })) };
  splits.unshift(split); renderSplitResult(split); renderHistory(); showToast('Split calculated. Check off each person as they pay.');
});
$('#copy-split-summary').addEventListener('click', async () => {
  const split = splits.find(item => item.id === activeSplitId);
  if (!split) { showToast('Open a saved split to copy its details.'); return; }
  const details = split.people.map(person => `${person.name}: ${money(person.share)}`).join(' · ');
  const message = `${split.name} — ${money(split.total)} total, split between ${split.people.length} people. ${details}.${split.qr ? ' Scan the payment QR I shared to pay.' : ''}`;
  try { await navigator.clipboard.writeText(message); showToast('Split details copied.'); } catch { showToast(message); }
});

function showBusinessModal() { $('#business-modal').hidden = false; }
$('#business-link').addEventListener('click', showBusinessModal);
$('#modal-close').addEventListener('click', () => $('#business-modal').hidden = true);
$('#modal-done').addEventListener('click', () => $('#business-modal').hidden = true);
$('#business-modal').addEventListener('click', event => { if (event.target === $('#business-modal')) $('#business-modal').hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('#business-modal').hidden = true; $('#sidebar').classList.remove('open'); } });
function authMessage(message, isError = false) { const el = $('#auth-message'); el.textContent = message; el.classList.toggle('error', isError); }
function openAuth(message = '', isError = false) { $('#auth-shade').hidden = false; authMessage(message, isError); }
function closeAuth() { $('#auth-shade').hidden = true; authMessage(''); }
function setAuthMode(mode) {
  $$('.auth-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.authMode === mode));
  const signup = mode === 'signup';
  $('#auth-title').textContent = signup ? 'Create your account.' : 'Welcome back.';
  $('#auth-subtitle').textContent = signup ? 'Create an account to save and sync your records.' : 'Log in to sync your records across devices.';
  $('#email-submit').innerHTML = `${signup ? 'Create account' : 'Log in'} <span>→</span>`;
  $('#auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('#email-auth-form').dataset.mode = mode;
  authMessage('');
}
function setAuthMethod(method) {
  $$('.method-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.method === method));
  $('#email-auth-form').hidden = method !== 'email';
  $('#phone-auth-form').hidden = method !== 'phone';
  authMessage('');
}
async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }); }
  catch { throw new Error('Can’t reach the app server. Open Gather at http://localhost:3000 to use accounts and database sync.'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Request failed. Please try again.');
  return result;
}
function paintAccount() {
  const button = $('#account-button');
  button.textContent = currentUser ? 'Sign out' : 'Sign in';
  button.title = currentUser ? `Signed in as ${currentUser.email || currentUser.phone}. Click to sign out.` : 'Log in or create an account';
  $('#save-indicator').innerHTML = currentUser ? '<span></span> Synced to your account' : '<span></span> Saved on this device';
}
async function syncToDatabase() {
  if (!currentUser) return;
  try { await api('/api/data/sync', { method: 'POST', body: JSON.stringify({ loans, splits }) }); paintAccount(); }
  catch (error) { $('#save-indicator').innerHTML = '<span class="offline-dot"></span> Sync paused'; showToast(error.message); }
}
async function loadAccountData() {
  const remote = await api('/api/data');
  if (!remote.loans.length && !remote.splits.length && (loans.length || splits.length)) {
    await syncToDatabase();
  } else {
    loans = remote.loans; splits = remote.splits;
    localStorage.setItem('gather-loans', JSON.stringify(loans)); localStorage.setItem('gather-splits', JSON.stringify(splits));
  }
  renderLoans(); renderHistory(); renderDashboard();
}
async function finishLogin(user) {
  currentUser = user; paintAccount(); closeAuth();
  try { await loadAccountData(); showToast('You’re signed in. Your records are syncing.'); }
  catch (error) { showToast(error.message); }
}
$('#account-button').addEventListener('click', async () => {
  if (!currentUser) { openAuth(appServerAvailable ? '' : 'Open Gather at http://localhost:3000 to use account sign-in and database storage.', !appServerAvailable); return; }
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); currentUser = null; paintAccount(); showToast('You’ve signed out.'); }
  catch (error) { showToast(error.message); }
});
$('#auth-close').addEventListener('click', closeAuth);
$('#auth-shade').addEventListener('click', event => { if (event.target === $('#auth-shade')) closeAuth(); });
$$('.auth-tab').forEach(tab => tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode)));
$$('.method-tab').forEach(tab => tab.addEventListener('click', () => setAuthMethod(tab.dataset.method)));
$('#email-auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const signup = event.currentTarget.dataset.mode === 'signup'; const button = $('#email-submit'); button.disabled = true; authMessage('Connecting securely…');
  try { const result = await api(`/api/auth/${signup ? 'signup' : 'login'}`, { method: 'POST', body: JSON.stringify({ email: $('#auth-email').value.trim(), password: $('#auth-password').value }) }); await finishLogin(result.user); }
  catch (error) { authMessage(error.message, true); }
  finally { button.disabled = false; }
});
$('#google-login').addEventListener('click', () => { if (googleAvailable) window.location.href = '/api/auth/google'; else authMessage('Google sign-in is ready in the screen. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env to activate it.', true); });
$('#phone-auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#phone-submit'); button.disabled = true; authMessage('Sending a verification code…');
  try { await api('/api/auth/phone/send', { method: 'POST', body: JSON.stringify({ phone: $('#auth-phone').value.trim() }) }); $('#otp-row').hidden = false; button.textContent = 'Send a new code'; authMessage('Verification code sent by SMS.'); }
  catch (error) { authMessage(error.message, true); }
  finally { button.disabled = false; }
});
$('#verify-otp').addEventListener('click', async () => {
  const button = $('#verify-otp'); button.disabled = true; authMessage('Checking your code…');
  try { const result = await api('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ phone: $('#auth-phone').value.trim(), code: $('#auth-otp').value.trim() }) }); await finishLogin(result.user); }
  catch (error) { authMessage(error.message, true); }
  finally { button.disabled = false; }
});
async function restoreSession() {
  if (new URLSearchParams(location.search).has('auth_error')) { openAuth('Google sign-in could not complete. Check the Google OAuth settings and redirect URL.', true); history.replaceState({}, '', '/'); }
  try {
    const state = await api('/api/session');
    appServerAvailable = true; googleAvailable = Boolean(state.googleAvailable);
    if (state.user) { currentUser = state.user; paintAccount(); await loadAccountData(); }
    else { paintAccount(); }
    if (!state.googleAvailable) $('#google-login').title = 'Google sign-in needs OAuth credentials in the app .env file.';
    const phoneAvailable = state.phoneAvailable;
    const phoneTab = document.querySelector('[data-method="phone"]');
    phoneTab.title = phoneAvailable ? 'Sign in with a phone verification code' : 'Phone sign-in needs SMS provider credentials in the app .env file.';
  } catch { appServerAvailable = false; paintAccount(); }
}
renderLoans(); renderHistory(); renderDashboard(); setPage('dashboard'); paintAccount(); restoreSession();
