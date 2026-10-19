const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
const safeRead = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const safeArrayRead = key => { const value = safeRead(key, []); return Array.isArray(value) ? value : []; };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let loans = safeArrayRead('gather-loans');
let splits = safeArrayRead('gather-splits');
let qrImage = '';
let activeSplitId = null;
let editingLoanId = null;
let editingSplitId = null;
let toastTimer;
let currentUser = null;
let remoteSaveTimer = null;
let appServerAvailable = false;
let googleAvailable = false;

function save() {
  try { persistLocalRecords(); }
  catch { showToast('Browser storage is full. Try a smaller QR image.'); }
  renderDashboard();
  if (currentUser) { clearTimeout(remoteSaveTimer); remoteSaveTimer = setTimeout(syncToDatabase, 350); }
}
function recordStorageKeys(user = currentUser) {
  return user ? { loans: `gather-user-${user.id}-loans`, splits: `gather-user-${user.id}-splits` } : { loans: 'gather-loans', splits: 'gather-splits' };
}
function readLocalRecords(user = currentUser) {
  const keys = recordStorageKeys(user);
  return { loans: safeArrayRead(keys.loans), splits: safeArrayRead(keys.splits) };
}
function persistLocalRecords() {
  const keys = recordStorageKeys();
  localStorage.setItem(keys.loans, JSON.stringify(loans));
  localStorage.setItem(keys.splits, JSON.stringify(splits));
}
function mergeById(primary, secondary) {
  const rows = new Map();
  for (const row of [...secondary, ...primary]) if (row?.id) rows.set(String(row.id), row);
  return [...rows.values()];
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
async function deleteRemoteRecord(collection, id) {
  if (!currentUser) return true;
  clearTimeout(remoteSaveTimer);
  if (!await syncToDatabase()) return false;
  try { await api(`/api/data/${collection}/${encodeURIComponent(id)}`, { method: 'DELETE' }); return true; }
  catch (error) { showToast(error.message); return false; }
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
  list.innerHTML = loans.map(item => `<article class="record-row"><span class="person-mark">${escapeHtml(initials(item.name))}</span><div class="record-main"><strong>${escapeHtml(item.name)}</strong><small>${new Date(item.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</small></div><div class="record-amount">${money(item.amount)}<small>${item.returned ? 'Returned' : 'Pending'}</small></div><div class="record-actions"><button class="record-action ${item.returned ? 'returned' : ''}" data-return="${escapeHtml(item.id)}">${item.returned ? '✓ Returned' : 'Mark returned'}</button><button class="record-action edit" data-edit-loan="${escapeHtml(item.id)}">Edit</button><button class="record-action delete" data-delete-loan="${escapeHtml(item.id)}">Delete</button></div></article>`).join('');
  list.querySelectorAll('[data-return]').forEach(button => button.addEventListener('click', () => {
    const loan = loans.find(item => item.id === button.dataset.return); loan.returned = !loan.returned; save(); renderLoans(); showToast(loan.returned ? `Marked ${loan.name} as returned.` : `Moved ${loan.name} back to pending.`);
  }));
  list.querySelectorAll('[data-edit-loan]').forEach(button => button.addEventListener('click', () => editLoan(button.dataset.editLoan)));
  list.querySelectorAll('[data-delete-loan]').forEach(button => button.addEventListener('click', async () => {
    const loan = loans.find(item => item.id === button.dataset.deleteLoan); if (!loan || !window.confirm(`Delete the lending record for ${loan.name}?`)) return;
    if (!await deleteRemoteRecord('loans', loan.id)) return;
    loans = loans.filter(item => item.id !== loan.id); if (editingLoanId === loan.id) resetLoanForm(); save(); renderLoans(); showToast('Lending record deleted.');
  }));
}

$('#lend-datetime').value = localDateTime();
function resetLoanForm() {
  editingLoanId = null; $('#lend-form').reset(); $('#lend-datetime').value = localDateTime();
  $('#save-loan-button').innerHTML = 'Save record <span>→</span>'; $('#cancel-loan-edit').hidden = true;
}
function editLoan(id) {
  const loan = loans.find(item => item.id === id); if (!loan) return;
  editingLoanId = loan.id; $('#person-name').value = loan.name; $('#lend-amount').value = loan.amount;
  const date = new Date(loan.date); $('#lend-datetime').value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $('#save-loan-button').innerHTML = 'Update record <span>→</span>'; $('#cancel-loan-edit').hidden = false;
  setPage('lend'); $('#lend-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('#cancel-loan-edit').addEventListener('click', resetLoanForm);
$('#lend-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#person-name').value.trim(); const amount = Number($('#lend-amount').value); const date = new Date($('#lend-datetime').value);
  if (!name || !Number.isFinite(amount) || amount <= 0 || Number.isNaN(date.getTime())) { showToast('Please enter a name, amount, and valid date and time.'); return; }
  if (editingLoanId) {
    const loan = loans.find(item => item.id === editingLoanId); if (loan) Object.assign(loan, { name, amount, date: date.toISOString() });
  } else loans.unshift({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name, amount, date: date.toISOString(), returned: false });
  const wasEditing = Boolean(editingLoanId); save(); renderLoans(); resetLoanForm(); showToast(`${wasEditing ? 'Updated' : 'Saved'} ${money(amount)} lent to ${name}.`);
});

function renderPayerOptions(count, selectedIndex) {
  const select = $('#split-payer-select'); const names = currentPeople();
  if (selectedIndex === undefined) selectedIndex = select.value === '' ? -1 : Number(select.value);
  select.innerHTML = '<option value="">Choose a person</option>' + Array.from({ length: count }, (_, index) => {
    const person = names[index] || `Person ${index + 1}`;
    return `<option value="${index}">${escapeHtml(person)}</option>`;
  }).join('');
  select.value = selectedIndex >= 0 && selectedIndex < count ? String(selectedIndex) : '';
  if ($('#payer-in-group').checked && !select.value && count) select.value = '0';
}
function renderPeopleInputs(count, existing = [], payerIndex) {
  const container = $('#people-inputs');
  if (payerIndex === undefined) {
    const selectedPayer = $('#split-payer-select')?.value ?? '';
    payerIndex = selectedPayer === '' ? -1 : Number(selectedPayer);
  }
  container.innerHTML = Array.from({ length: count }, (_, index) => {
    const value = existing[index] ?? '';
    return `<label class="person-input-row"><span class="person-input-index">${index + 1}</span><input data-person-index="${index}" maxlength="40" value="${escapeHtml(value)}" placeholder="Person ${index + 1} (optional)" aria-label="Person ${index + 1} name, optional"></label>`;
  }).join('');
  $('#people-count-label').textContent = `${count} ${count === 1 ? 'person' : 'people'}`;
  renderPayerOptions(count, payerIndex);
}
function currentPeople() { return $$('#people-inputs input').map(input => input.value.trim()); }
function validCount(value) { const count = Math.floor(Number(value)); return Number.isFinite(count) ? Math.max(1, Math.min(100, count)) : 1; }
$('#people-count').addEventListener('change', event => {
  const oldNames = currentPeople(); const count = validCount(event.target.value); event.target.value = count; renderPeopleInputs(count, oldNames);
});
$('#people-count').addEventListener('blur', event => {
  const oldNames = currentPeople(); const count = validCount(event.target.value); event.target.value = count; renderPeopleInputs(count, oldNames);
});
$('#people-inputs').addEventListener('input', () => renderPayerOptions(currentPeople().length, $('#split-payer-select').value === '' ? -1 : Number($('#split-payer-select').value)));
$('#payer-in-group').addEventListener('change', event => {
  $('#split-payer-select').disabled = !event.target.checked;
  if (event.target.checked && !$('#split-payer-select').value) $('#split-payer-select').value = '0';
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
  $('#split-people-list').innerHTML = split.people.map(person => `<div class="split-person-row"><input class="paid-check" type="checkbox" data-paid="${escapeHtml(person.id)}" ${person.paid ? 'checked' : ''} ${person.isPayer ? 'disabled' : ''} aria-label="Mark ${escapeHtml(person.name)} as paid"><span class="person-mark">${escapeHtml(initials(person.name))}</span><div class="record-main"><strong>${escapeHtml(person.name)}</strong><small>${person.isPayer ? 'Bill payer · paid' : person.paid ? 'Paid' : 'Still to pay'}</small></div><div class="record-amount">${money(person.share)}<small>their share</small></div></div>`).join('');
  const qr = $('#result-qr-wrap');
  qr.innerHTML = split.qr ? `<img src="${split.qr}" alt="Payment QR code"><span><strong>Payment QR attached</strong><small>Friends can scan to pay you</small></span>` : '<span><strong>No payment QR attached</strong><small>You can add one to your next bill</small></span>';
  const downloadQr = $('#download-qr');
  if (split.qr) {
    downloadQr.href = split.qr;
    const mime = split.qr.match(/^data:(image\/[^;,]+)/i)?.[1] || 'image/png';
    const extension = (mime.split('/')[1] || 'png').split('+')[0].replace(/[^a-z0-9]/gi, '') || 'png';
    downloadQr.download = `${(split.name || 'gather-payment-qr').replace(/[^a-z0-9-_]+/gi, '-').slice(0, 40)}-qr.${extension === 'jpeg' ? 'jpg' : extension}`;
    downloadQr.hidden = false;
  }
  else { downloadQr.removeAttribute('href'); downloadQr.hidden = true; }
  $('#split-people-list').querySelectorAll('[data-paid]').forEach(input => input.addEventListener('change', () => {
    const person = split.people.find(item => item.id === input.dataset.paid); person.paid = input.checked; save(); renderSplitResult(split); renderHistory(); showToast(`${person.name} marked ${person.paid ? 'paid' : 'unpaid'}.`);
  }));
  save();
}
function renderHistory() {
  const list = $('#split-history');
  if (!splits.length) { list.innerHTML = '<div class="empty-record"><span class="empty-record-icon">⌁</span><div><strong>No group bills yet</strong><p>Your created bill splits will appear here.</p></div></div>'; return; }
  list.innerHTML = splits.map(split => { const paid = split.people.filter(person => person.paid).length; return `<div class="history-row"><span class="heading-symbol green">⌁</span><div class="record-main"><strong>${escapeHtml(split.name)}</strong><small>${split.people.length} ${split.people.length === 1 ? 'person' : 'people'} · ${new Date(split.created).toLocaleDateString()}</small></div><span class="history-progress">${paid}/${split.people.length} paid</span><div class="record-actions"><button class="history-open" data-open-split="${escapeHtml(split.id)}">Open</button><button class="history-open" data-edit-split="${escapeHtml(split.id)}">Edit</button><button class="history-open delete" data-delete-split="${escapeHtml(split.id)}">Delete</button></div></div>`; }).join('');
  list.querySelectorAll('[data-open-split]').forEach(button => button.addEventListener('click', () => { const split = splits.find(item => item.id === button.dataset.openSplit); renderSplitResult(split); $('#split-result-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
  list.querySelectorAll('[data-edit-split]').forEach(button => button.addEventListener('click', () => editSplit(button.dataset.editSplit)));
  list.querySelectorAll('[data-delete-split]').forEach(button => button.addEventListener('click', async () => {
    const split = splits.find(item => item.id === button.dataset.deleteSplit); if (!split || !window.confirm(`Delete the group bill “${split.name}”?`)) return;
    if (!await deleteRemoteRecord('splits', split.id)) return;
    splits = splits.filter(item => item.id !== split.id); if (editingSplitId === split.id) resetSplitForm();
    if (activeSplitId === split.id) { activeSplitId = null; $('#split-result-card').hidden = true; }
    save(); renderHistory(); renderDashboard(); showToast('Group bill deleted.');
  }));
}
function resetSplitForm() {
  editingSplitId = null; qrImage = ''; $('#split-form').reset(); $('#people-count').value = 2; renderPeopleInputs(2);
  $('#payer-in-group').checked = false; $('#split-payer-select').disabled = true; $('#split-payer-select').value = '';
  $('#qr-file-label').textContent = 'Add QR code'; $('#receipt-label').textContent = 'Upload file'; $('#receipt-status').textContent = '';
  $('#save-split-button').innerHTML = 'Calculate split <span>→</span>'; $('#cancel-split-edit').hidden = true;
}
function editSplit(id) {
  const split = splits.find(item => item.id === id); if (!split) return;
  editingSplitId = split.id; $('#bill-name').value = split.name; $('#bill-total').value = split.total;
  const payerIndex = split.people.findIndex(person => person.isPayer);
  $('#payer-in-group').checked = payerIndex >= 0; $('#split-payer-select').disabled = payerIndex < 0;
  $('#people-count').value = split.people.length; renderPeopleInputs(split.people.length, split.people.map(person => person.name), payerIndex);
  qrImage = split.qr || ''; $('#qr-file-label').textContent = qrImage ? '✓ QR added' : 'Add QR code';
  $('#save-split-button').innerHTML = 'Update split <span>→</span>'; $('#cancel-split-edit').hidden = false;
  setPage('split'); $('#split-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('#cancel-split-edit').addEventListener('click', resetSplitForm);
$('#split-form').addEventListener('submit', event => {
  event.preventDefault();
  const rawCount = $('#people-count').value;
  if (!rawCount || !Number.isInteger(Number(rawCount)) || Number(rawCount) < 1) { showToast('Enter a whole number of people.'); return; }
  const count = validCount(rawCount); const names = currentPeople();
  if (names.length !== count) { showToast('Check the number of people in the split.'); return; }
  const total = Number($('#bill-total').value); if (!Number.isFinite(total) || total <= 0) { showToast('Enter a bill total greater than zero.'); return; }
  const existing = editingSplitId ? splits.find(item => item.id === editingSplitId) : null;
  const resolvedNames = names.map((name, index) => name || `Person ${index + 1}`);
  const payerIndex = $('#payer-in-group').checked ? Number($('#split-payer-select').value) : -1;
  if ($('#payer-in-group').checked && (!Number.isInteger(payerIndex) || payerIndex < 0 || payerIndex >= count)) { showToast('Choose who paid the bill.'); return; }
  const oldPayerIndex = existing?.people.findIndex(person => person.isPayer) ?? -1;
  const participantsChanged = !existing || existing.total !== total || existing.people.length !== resolvedNames.length || existing.people.some((person, index) => person.name !== resolvedNames[index]) || oldPayerIndex !== payerIndex;
  const people = resolvedNames.map((name, index) => {
    const previous = existing?.people[index];
    const isPayer = payerIndex === index;
    return { id: previous?.name === name ? previous.id : `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`, name, paid: isPayer || (!participantsChanged && previous?.name === name ? Boolean(previous.paid) : false), ...(isPayer ? { isPayer: true } : {}) };
  });
  const split = existing
    ? Object.assign(existing, { name: $('#bill-name').value.trim(), total, qr: qrImage, people })
    : { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: $('#bill-name').value.trim(), total, created: new Date().toISOString(), qr: qrImage, people };
  if (!existing) splits.unshift(split);
  renderSplitResult(split); renderHistory();
  if (existing) resetSplitForm();
  showToast(existing ? 'Group bill updated.' : 'Split calculated. Check off each person as they pay.');
});
$('#copy-split-summary').addEventListener('click', async () => {
  const split = splits.find(item => item.id === activeSplitId);
  if (!split) { showToast('Open a saved split to copy its details.'); return; }
  const details = split.people.map(person => `${person.name}: ${money(person.share)}`).join(' · ');
  const message = `${split.name} — ${money(split.total)} total, split between ${split.people.length} people.\n${details}${split.qr ? '\nPayment QR attached.' : ''}`;
  try { await navigator.clipboard.writeText(message); showToast(split.qr ? 'Details copied. Use Share bill to include the QR.' : 'Split details copied.'); } catch { showToast(message); }
});
$('#share-split').addEventListener('click', async () => {
  const split = splits.find(item => item.id === activeSplitId);
  if (!split) { showToast('Open a saved split before sharing it.'); return; }
  const details = split.people.map(person => `${person.name}: ${money(person.share)}`).join('\n');
  const text = `${split.name} — ${money(split.total)} total\n${details}`;
  try {
    if (navigator.share) {
      const payload = { title: split.name || 'Gather group bill', text };
      if (split.qr && typeof File !== 'undefined') {
        const blob = await fetch(split.qr).then(response => response.blob());
        const extension = blob.type.includes('jpeg') ? 'jpg' : blob.type.split('/')[1] || 'png';
        const file = new File([blob], `gather-payment-qr.${extension}`, { type: blob.type || 'image/png' });
        if (navigator.canShare?.({ files: [file] })) payload.files = [file];
      }
      await navigator.share(payload);
      showToast(split.qr && !payload.files ? 'Details shared. Download and attach the QR separately on this device.' : 'Split details shared.');
      return;
    }
    await navigator.clipboard.writeText(text);
    showToast(split.qr ? 'Details copied. Download the QR below to attach it.' : 'Split details copied.');
  } catch (error) {
    if (error.name === 'AbortError') return;
    try { await navigator.clipboard.writeText(text); showToast(split.qr ? 'Details copied. Download the QR below to attach it.' : 'Split details copied.'); }
    catch { showToast('Sharing is unavailable here. You can copy each amount from the checklist.'); }
  }
});

function showBusinessModal() { $('#business-modal').hidden = false; }
$('#business-link').addEventListener('click', showBusinessModal);
$('#modal-close').addEventListener('click', () => $('#business-modal').hidden = true);
$('#modal-done').addEventListener('click', () => $('#business-modal').hidden = true);
$('#business-modal').addEventListener('click', event => { if (event.target === $('#business-modal')) $('#business-modal').hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('#business-modal').hidden = true; $('#sidebar').classList.remove('open'); } });
function authMessage(message, isError = false) { const el = $('#auth-message'); el.textContent = message; el.classList.toggle('error', isError); }
function openAuth(message = '', isError = false) {
  setAuthMode('signin'); setAuthMethod('email');
  $('#otp-row').hidden = true; $('#auth-otp').value = ''; $('#phone-submit').innerHTML = 'Send verification code <span>→</span>';
  $('#auth-shade').hidden = false; authMessage(message, isError);
}
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
  $('#split-storage-note').innerHTML = currentUser ? '<span>⌑</span> Your bill and payment list sync to your account.' : '<span>⌑</span> Your bill and payment list stay on this device.';
}
async function syncToDatabase() {
  if (!currentUser) return false;
  try { await api('/api/data/sync', { method: 'POST', body: JSON.stringify({ loans, splits }) }); paintAccount(); return true; }
  catch (error) { $('#save-indicator').innerHTML = '<span class="offline-dot"></span> Sync paused'; showToast(error.message); return false; }
}
async function loadAccountData({ offerGuestImport = false } = {}) {
  const remote = await api('/api/data');
  const accountCache = readLocalRecords(currentUser);
  const guestCache = readLocalRecords(null);
  const hasRows = rows => rows.loans.length > 0 || rows.splits.length > 0;
  let selected = null; let shouldSync = false;
  if (offerGuestImport && hasRows(guestCache)) {
    const accountName = currentUser.email || currentUser.phone || 'this account';
    if (window.confirm(`This browser has unsynced lending records or group bills. Copy them into ${accountName}? Existing records in that account will be kept.`)) {
      selected = {
        loans: mergeById(remote.loans, mergeById(accountCache.loans, guestCache.loans)),
        splits: mergeById(remote.splits, mergeById(accountCache.splits, guestCache.splits))
      };
      shouldSync = true;
    }
  }
  if (!selected) {
    if (hasRows(remote)) selected = remote;
    else if (hasRows(accountCache)) { selected = accountCache; shouldSync = true; }
    else selected = { loans: [], splits: [] };
  }
  loans = selected.loans; splits = selected.splits; persistLocalRecords();
  if (shouldSync) await syncToDatabase();
  renderLoans(); renderHistory(); renderDashboard();
}
async function finishLogin(user) {
  currentUser = user; ({ loans, splits } = readLocalRecords(user)); paintAccount(); closeAuth();
  try { await loadAccountData({ offerGuestImport: true }); showToast('You’re signed in. Your records are syncing.'); }
  catch (error) { showToast(error.message); }
}
$('#account-button').addEventListener('click', async () => {
  if (!currentUser) { openAuth(appServerAvailable ? '' : 'Open Gather at http://localhost:3000 to use account sign-in and database storage.', !appServerAvailable); return; }
  clearTimeout(remoteSaveTimer); await syncToDatabase();
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); currentUser = null; ({ loans, splits } = readLocalRecords(null)); paintAccount(); renderLoans(); renderHistory(); renderDashboard(); showToast('You’ve signed out.'); }
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
    if (state.user) { currentUser = state.user; ({ loans, splits } = readLocalRecords(currentUser)); paintAccount(); await loadAccountData(); }
    else { paintAccount(); }
    $('#google-login').disabled = !state.googleAvailable;
    if (!state.googleAvailable) $('#google-login').title = 'Google sign-in needs OAuth credentials configured by the app owner.';
    const phoneAvailable = Boolean(state.phoneAvailable);
    const phoneTab = document.querySelector('[data-method="phone"]');
    phoneTab.disabled = !phoneAvailable;
    phoneTab.title = phoneAvailable ? 'Sign in with a phone verification code' : 'Phone sign-in needs SMS provider credentials configured by the app owner.';
  } catch { appServerAvailable = false; $('#google-login').disabled = true; document.querySelector('[data-method="phone"]').disabled = true; paintAccount(); }
}
renderLoans(); renderHistory(); renderDashboard(); setPage('dashboard'); paintAccount(); restoreSession();

