const grid = document.getElementById('file-grid');
const emptyState = document.getElementById('empty-state');
const searchInput = document.getElementById('search-input');
const toast = document.getElementById('toast');
const transfers = document.getElementById('transfers');
const scrim = document.getElementById('scrim');
const memorySection = document.getElementById('memory-results');
const memoryList = document.getElementById('memory-list');

/* ---------- small helpers ---------- */

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

/* ---------- sheets ---------- */

const sheets = {
  add: document.getElementById('add-sheet'),
  note: document.getElementById('note-sheet'),
  link: document.getElementById('link-sheet'),
  memory: document.getElementById('memory-sheet'),
  voice: document.getElementById('voice-sheet'),
};

let openSheet = null;
let sheetTimer = null;

function showSheet(name) {
  closeSheet();
  // A close still finishing its slide must not hide the sheet we are opening.
  clearTimeout(sheetTimer);
  const sheet = sheets[name];
  openSheet = sheet;
  sheet.classList.remove('hidden');
  scrim.classList.remove('hidden');
  void sheet.offsetHeight; // settle the starting position so the slide animates
  sheet.classList.add('open');
  scrim.classList.add('open');
}

function closeSheet() {
  if (!openSheet) return;
  const sheet = openSheet;
  openSheet = null;
  clearTimeout(sheetTimer);
  sheet.classList.remove('open');
  scrim.classList.remove('open');
  sheetTimer = setTimeout(() => {
    if (openSheet) return;
    sheet.classList.add('hidden');
    scrim.classList.add('hidden');
  }, 240);
  stopRecording(true);
}

scrim.addEventListener('click', closeSheet);
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

document.getElementById('add-fab').addEventListener('click', () => showSheet('add'));

document.querySelectorAll('.option').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    closeSheet();
    setTimeout(() => {
      if (action === 'file') document.getElementById('file-input').click();
      else if (action === 'photo') document.getElementById('photo-input').click();
      else showSheet(action);
    }, 180);
  });
});

/* ---------- rendering the grid ---------- */

const ICONS = {
  pdf: '<path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.6 17v-3.4h.9c.6 0 1 .5 1 1.1v1.2c0 .6-.4 1.1-1 1.1h-.9Zm3.6 0v-3.4h1.5M12.2 15.2h1.2m2.1 1.8v-3.4h1.5" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  document: '<path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 13h6M9 16h6M9 10h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  notepad: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  bookmark: '<path d="M10 13.5a4 4 0 0 0 5.7.4l2.6-2.4a4 4 0 0 0-5.4-5.9l-1.5 1.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M14 10.5a4 4 0 0 0-5.7-.4l-2.6 2.4a4 4 0 0 0 5.4 5.9l1.5-1.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  video: '<rect x="3" y="6" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M17 10.5l4-2.3v7.6l-4-2.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  audio: '<rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4c.4 0 .8.2 1.1.5l1.3 1.5H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  default: '<path d="M7 3h10l3 3v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M17 3v3h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
};

function iconKeyFor(file) {
  if (file.kind === 'video') return 'video';
  if (file.kind === 'audio' || file.kind === 'voicenote') return 'audio';
  if (file.kind === 'folder') return 'folder';
  if (file.kind === 'notepad') return 'notepad';
  if (file.kind === 'bookmark') return 'bookmark';
  if (file.extension === 'pdf') return 'pdf';
  if (file.kind === 'document') return 'document';
  return 'default';
}

function bestThumbUrl(file) {
  const t = file.thumbnail;
  if (t && (t.md || t.sm || t.lg)) return t.md || t.sm || t.lg;
  if (file.kind === 'image') return file.fileUrl || null;
  return null;
}

function renderFiles(files) {
  grid.innerHTML = '';
  for (const file of files) {
    const a = document.createElement('a');
    a.className = 'file-card';
    a.href = file.originUrl || file.url || '#';
    a.target = '_blank';
    a.rel = 'noopener';

    const thumb = document.createElement('div');
    thumb.className = 'file-thumb';
    const thumbUrl = bestThumbUrl(file);
    if (thumbUrl) {
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = file.name;
      img.loading = 'lazy';
      // Link previews are often pale logos, so they need a plain backdrop.
      thumb.classList.add('has-image');
      img.addEventListener('error', () => {
        thumb.classList.remove('has-image');
        const key = iconKeyFor(file);
        thumb.classList.add('icon-' + key);
        thumb.innerHTML = `<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">${ICONS[key]}</svg>`;
      });
      thumb.appendChild(img);
    } else {
      const key = iconKeyFor(file);
      thumb.classList.add('icon-' + key);
      thumb.innerHTML = `<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">${ICONS[key]}</svg>`;
    }

    const name = document.createElement('div');
    name.className = 'file-name';
    // Some sites hide their title, so fall back to the address itself.
    name.textContent = file.name || hostOf(file.originUrl) || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const host = file.kind === 'bookmark' ? hostOf(file.originUrl) : null;
    meta.textContent = host && host !== name.textContent
      ? `${host} · ${formatDate(file.createdAt)}`
      : formatDate(file.createdAt);

    a.append(thumb, name, meta);
    grid.appendChild(a);
  }
}

function renderMemories(memories) {
  memoryList.innerHTML = '';
  memorySection.classList.toggle('hidden', !memories.length);
  for (const m of memories) {
    const card = document.createElement('div');
    card.className = 'memory-card';
    const body = document.createElement('p');
    body.className = 'memory-text';
    body.textContent = m.content;
    card.appendChild(body);
    if (m.name) {
      const label = document.createElement('div');
      label.className = 'memory-label';
      label.textContent = m.name;
      card.prepend(label);
    }
    memoryList.appendChild(card);
  }
}

function updateEmptyState(fileCount, memoryCount) {
  const busy = transfers.children.length > 0;
  emptyState.classList.toggle('hidden', fileCount > 0 || memoryCount > 0 || busy);
}

async function loadRecent() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderFiles(data.files || []);
    renderMemories([]);
    updateEmptyState((data.files || []).length, 0);
  } catch (err) {
    showToast('Could not load your files. Pull down to try again.');
  }
}

/* ---------- search ---------- */

let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  searchDebounce = setTimeout(async () => {
    if (!q) return loadRecent();
    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      renderFiles(data.files || []);
      renderMemories(data.memories || []);
      updateEmptyState((data.files || []).length, (data.memories || []).length);
    } catch (err) {
      showToast('Search did not work. Please try again.');
    }
  }, 320);
});

/* ---------- uploading ---------- */

// Bytes go straight from the phone to storage, so a slow connection never ties
// up our server and we can show honest progress. If that direct route is
// blocked we fall back to sending the file through the server instead.
function putWithProgress(url, headers, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers || {})) {
      if (v != null) xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new Error('Storage refused the file (' + xhr.status + ')')));
    xhr.onerror = () => reject(new Error('Connection dropped'));
    xhr.ontimeout = () => reject(new Error('It took too long'));
    xhr.send(file);
  });
}

function makeTransferRow(name, size) {
  const row = document.createElement('div');
  row.className = 'transfer';
  row.innerHTML = `
    <div class="transfer-top">
      <span class="transfer-name"></span>
      <span class="transfer-status">Preparing...</span>
    </div>
    <div class="transfer-track"><div class="transfer-bar"></div></div>
  `;
  row.querySelector('.transfer-name').textContent = size ? `${name} · ${formatSize(size)}` : name;
  transfers.appendChild(row);
  return {
    row,
    setProgress(fraction) {
      row.querySelector('.transfer-bar').style.width = Math.round(fraction * 100) + '%';
      row.querySelector('.transfer-status').textContent = Math.round(fraction * 100) + '%';
    },
    setStatus(text) {
      row.querySelector('.transfer-status').textContent = text;
    },
    fail(message, onRetry) {
      row.classList.add('failed');
      row.querySelector('.transfer-status').textContent = message;
      const retry = document.createElement('button');
      retry.className = 'transfer-retry';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => { row.remove(); onRetry(); });
      row.appendChild(retry);
    },
    done() {
      row.remove();
    },
  };
}

async function uploadViaServer(file, isVoiceNote, ui) {
  ui.setStatus('Sending...');
  const form = new FormData();
  form.append('file', file, file.name);
  if (isVoiceNote) form.append('isVoiceNote', 'true');
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
}

async function uploadOne(file, { isVoiceNote = false } = {}) {
  const ui = makeTransferRow(file.name, file.size);
  updateEmptyState(grid.children.length, memoryList.children.length);

  const attempt = async () => {
    try {
      ui.setStatus('Preparing...');
      const presign = await postJson('/api/upload/presign', {
        filename: file.name,
        size: file.size,
      });

      try {
        await putWithProgress(presign.url, presign.headers, file, ui.setProgress);
      } catch (directErr) {
        // Storage would not take it straight from the phone; go via the server.
        await uploadViaServer(file, isVoiceNote, ui);
        ui.done();
        showToast(`Saved ${file.name}`);
        loadRecent();
        return;
      }

      ui.setStatus('Saving...');
      await postJson('/api/upload/commit', {
        path: presign.path,
        filename: file.name,
        mimeType: file.type,
        isVoiceNote,
      });

      ui.done();
      showToast(`Saved ${file.name}`);
      loadRecent();
    } catch (err) {
      console.error('Upload failed', err);
      ui.fail('Not sent', attempt);
      updateEmptyState(grid.children.length, memoryList.children.length);
    }
  };

  await attempt();
}

function handlePickedFiles(input) {
  const files = Array.from(input.files || []);
  input.value = '';
  files.forEach((file) => uploadOne(file));
}

document.getElementById('file-input').addEventListener('change', (e) => handlePickedFiles(e.target));
document.getElementById('photo-input').addEventListener('change', (e) => handlePickedFiles(e.target));

/* ---------- note, link, memory ---------- */

function wireSaveButton(buttonId, handler) {
  const button = document.getElementById(buttonId);
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Saving...';
    try {
      await handler();
      closeSheet();
    } catch (err) {
      showToast(err.message || 'Could not save that');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

wireSaveButton('note-save', async () => {
  const title = document.getElementById('note-title');
  const body = document.getElementById('note-body');
  if (!body.value.trim()) throw new Error('Write something first');
  await postJson('/api/notes', { title: title.value, text: body.value });
  title.value = '';
  body.value = '';
  showToast('Note saved');
  loadRecent();
});

wireSaveButton('link-save', async () => {
  const url = document.getElementById('link-url');
  if (!url.value.trim()) throw new Error('Paste a link first');
  await postJson('/api/links', { url: url.value });
  url.value = '';
  showToast('Link saved');
  loadRecent();
});

wireSaveButton('memory-save', async () => {
  const body = document.getElementById('memory-body');
  if (body.value.trim().length < 5) throw new Error('Write a little more to remember it');
  await postJson('/api/memories', { text: body.value });
  body.value = '';
  showToast('I will remember that. Search for it any time.');
});

/* ---------- voice recording ---------- */

const voiceButton = document.getElementById('voice-button');
const voiceTimer = document.getElementById('voice-timer');
const voiceHint = document.getElementById('voice-hint');
const voiceSave = document.getElementById('voice-save');

let recorder = null;
let recordedChunks = [];
let recordedBlob = null;
let recordTimer = null;
let recordStartedAt = 0;

function tickTimer() {
  const seconds = Math.floor((Date.now() - recordStartedAt) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  voiceTimer.textContent = `${mm}:${ss}`;
}

function pickAudioType() {
  const candidates = ['audio/webm', 'audio/mp4', 'audio/ogg'];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    voiceHint.textContent = 'This phone cannot record here. You can upload an audio file instead.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickAudioType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recordedChunks = [];
    recordedBlob = null;
    recorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recordedChunks.length) {
        recordedBlob = new Blob(recordedChunks, { type: recorder.mimeType || 'audio/webm' });
        voiceSave.disabled = false;
        voiceHint.textContent = 'Ready to save. Tap the mic to record again.';
      }
    };
    recorder.start();
    recordStartedAt = Date.now();
    tickTimer();
    recordTimer = setInterval(tickTimer, 500);
    voiceButton.classList.add('recording');
    voiceButton.setAttribute('aria-label', 'Stop recording');
    voiceHint.textContent = 'Recording... tap again to stop.';
    voiceSave.disabled = true;
  } catch (err) {
    voiceHint.textContent = 'Microphone permission was not given. Please allow it in your phone settings.';
  }
}

function stopRecording(discard = false) {
  clearInterval(recordTimer);
  voiceButton.classList.remove('recording');
  voiceButton.setAttribute('aria-label', 'Start recording');
  if (recorder && recorder.state === 'recording') recorder.stop();
  recorder = null;
  if (discard) {
    recordedChunks = [];
    recordedBlob = null;
    voiceSave.disabled = true;
    voiceTimer.textContent = 'Tap to start';
    voiceHint.textContent = 'Your phone will ask for microphone permission the first time.';
  }
}

voiceButton.addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') stopRecording();
  else startRecording();
});

voiceSave.addEventListener('click', () => {
  if (!recordedBlob) return;
  const ext = (recordedBlob.type.includes('mp4') && 'm4a')
    || (recordedBlob.type.includes('ogg') && 'ogg')
    || 'webm';
  const stamp = new Date().toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).replace(/[,:]/g, '').replace(/\s+/g, '-');
  const file = new File([recordedBlob], `Voice-${stamp}.${ext}`, { type: recordedBlob.type });
  closeSheet();
  uploadOne(file, { isVoiceNote: true });
});

/* ---------- start ---------- */

loadRecent();

// iOS Safari has no install prompt event, so show a manual one-time tip.
(function iosInstallTip() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  if (isIos && !isStandalone && !localStorage.getItem('installTipDismissed')) {
    const tip = document.getElementById('ios-install-tip');
    tip.classList.remove('hidden');
    document.getElementById('ios-tip-close').addEventListener('click', () => {
      tip.classList.add('hidden');
      localStorage.setItem('installTipDismissed', '1');
    });
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
