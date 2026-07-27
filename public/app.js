const grid = document.getElementById('file-grid');
const emptyState = document.getElementById('empty-state');
const searchInput = document.getElementById('search-input');
const toast = document.getElementById('toast');
const transfers = document.getElementById('transfers');
const scrim = document.getElementById('scrim');
const memorySection = document.getElementById('memory-results');
const memoryList = document.getElementById('memory-list');
const tagBar = document.getElementById('tag-bar');
const busy = document.getElementById('busy');
const loadError = document.getElementById('load-error');

let knownTags = [];
let activeTagId = null;
let lastFiles = [];

/* ---------- small helpers ---------- */

let toastTimer;
function showToast(msg, action) {
  toast.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = msg;
  toast.appendChild(text);
  if (action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      toast.classList.add('hidden');
      action.run();
    });
    toast.appendChild(button);
  }
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  // Undo is the only way back from a mistaken delete, so it waits much longer.
  toastTimer = setTimeout(() => toast.classList.add('hidden'), action ? 15000 : 3000);
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
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
  details: document.getElementById('details-sheet'),
  note: document.getElementById('note-sheet'),
  link: document.getElementById('link-sheet'),
  memory: document.getElementById('memory-sheet'),
  voice: document.getElementById('voice-sheet'),
};

let openSheet = null;
let sheetTimer = null;

/* ---------- the phone's own Back button ---------- */

// Opening a sheet or the viewer adds one step to the phone's history, so Back
// closes that and nothing else. Without this, Back walks out of the whole app.
let overlayPushed = false;

function anyOverlayOpen() {
  return !!openSheet || !document.getElementById('viewer').classList.contains('hidden');
}

function pushOverlayStep() {
  if (overlayPushed) return;
  overlayPushed = true;
  history.pushState({ cabinetOverlay: true }, '');
}

function dropOverlayStep() {
  if (!overlayPushed) return;
  overlayPushed = false;
  history.back();
}

window.addEventListener('popstate', () => {
  overlayPushed = false;
  if (!document.getElementById('viewer').classList.contains('hidden')) closeViewer(true);
  else if (openSheet) closeSheet(true);
});

function showSheet(name) {
  closeSheet(true); // swapping one sheet for another is not a new history step
  // A close still finishing its slide must not hide the sheet we are opening.
  clearTimeout(sheetTimer);
  const sheet = sheets[name];
  openSheet = sheet;
  sheet.classList.remove('hidden');
  scrim.classList.remove('hidden');
  document.body.classList.add('locked');
  void sheet.offsetHeight; // settle the starting position so the slide animates
  sheet.classList.add('open');
  scrim.classList.add('open');
  pushOverlayStep();
}

// Whatever was half-typed belongs to the moment she backed out of, not to the
// next thing she saves.
function clearSheetFields(sheet) {
  if (sheet === sheets.note) {
    document.getElementById('note-title').value = '';
    document.getElementById('note-body').value = '';
    notePicker.reset();
  } else if (sheet === sheets.link) {
    document.getElementById('link-url').value = '';
    document.getElementById('link-description').value = '';
    linkPicker.reset();
  } else if (sheet === sheets.memory) {
    document.getElementById('memory-body').value = '';
  } else if (sheet === sheets.details && pendingFiles.length) {
    const dropped = pendingFiles.length;
    pendingFiles = [];
    showToast(dropped === 1 ? 'That file was not saved' : `Those ${dropped} files were not saved`);
  }
}

function closeSheet(fromHistory = false) {
  if (!openSheet) return;
  const sheet = openSheet;
  openSheet = null;
  clearSheetFields(sheet);
  clearTimeout(sheetTimer);
  sheet.classList.remove('open');
  scrim.classList.remove('open');
  sheetTimer = setTimeout(() => {
    if (openSheet) return;
    sheet.classList.add('hidden');
    scrim.classList.add('hidden');
  }, 240);
  stopRecording(true);
  if (!anyOverlayOpen()) document.body.classList.remove('locked');
  if (!fromHistory && !anyOverlayOpen()) dropOverlayStep();
}

scrim.addEventListener('click', () => closeSheet());
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('viewer').classList.contains('hidden')) closeViewer();
  else closeSheet();
});

window.addEventListener('pagehide', () => releaseMic());

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

/* ---------- label picker ---------- */

// One picker per sheet: chosen labels as chips, free typing, and one-tap reuse
// of labels already used in this cabinet.
function createTagPicker(chosenEl, inputEl, suggestionsEl) {
  let chosen = [];

  function renderChosen() {
    chosenEl.innerHTML = '';
    chosen.forEach((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chip-chosen';
      chip.innerHTML = `<span></span><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
      chip.querySelector('span').textContent = name;
      chip.addEventListener('click', () => {
        chosen = chosen.filter((n) => n !== name);
        renderChosen();
        renderSuggestions();
      });
      chosenEl.appendChild(chip);
    });
  }

  function renderSuggestions() {
    suggestionsEl.innerHTML = '';
    knownTags
      .filter((t) => !chosen.some((n) => n.toLowerCase() === t.name.toLowerCase()))
      .slice(0, 10)
      .forEach((t) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = t.name;
        chip.addEventListener('click', () => add(t.name));
        suggestionsEl.appendChild(chip);
      });
  }

  function add(name) {
    const clean = (name || '').trim();
    if (!clean) return;
    if (!chosen.some((n) => n.toLowerCase() === clean.toLowerCase())) chosen.push(clean);
    inputEl.value = '';
    renderChosen();
    renderSuggestions();
  }

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(inputEl.value);
    } else if (e.key === 'Backspace' && !inputEl.value && chosen.length) {
      chosen.pop();
      renderChosen();
      renderSuggestions();
    }
  });

  return {
    getTags() {
      // Anything typed but not yet entered should still count.
      const pending = inputEl.value.trim();
      return pending && !chosen.some((n) => n.toLowerCase() === pending.toLowerCase())
        ? [...chosen, pending]
        : [...chosen];
    },
    reset() {
      chosen = [];
      inputEl.value = '';
      renderChosen();
      renderSuggestions();
    },
    refresh: renderSuggestions,
  };
}

const detailsPicker = createTagPicker(
  document.getElementById('details-chosen'),
  document.getElementById('details-tag-input'),
  document.getElementById('details-suggestions')
);
const notePicker = createTagPicker(
  document.getElementById('note-chosen'),
  document.getElementById('note-tag-input'),
  document.getElementById('note-suggestions')
);
const linkPicker = createTagPicker(
  document.getElementById('link-chosen'),
  document.getElementById('link-tag-input'),
  document.getElementById('link-suggestions')
);

/* ---------- the label bar under search ---------- */

function renderTagBar() {
  // Rebuilding the row resets how far it was scrolled, which would push the
  // label she just tapped off the side of the screen.
  const scrolledTo = tagBar.scrollLeft;
  tagBar.innerHTML = '';
  tagBar.classList.toggle('hidden', knownTags.length === 0);
  if (!knownTags.length) return;
  requestAnimationFrame(() => { tagBar.scrollLeft = scrolledTo; });

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'chip' + (activeTagId ? '' : ' chip-active');
  all.textContent = 'All';
  all.addEventListener('click', () => { activeTagId = null; refresh(); });
  tagBar.appendChild(all);

  knownTags.forEach((t) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (activeTagId === t.id ? ' chip-active' : '');
    chip.textContent = t.name;
    chip.addEventListener('click', () => {
      activeTagId = activeTagId === t.id ? null : t.id;
      refresh();
    });
    tagBar.appendChild(chip);
  });
}

/* ---------- rendering the grid ---------- */

const ICONS = {
  pdf: '<path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><text x="12" y="17.4" text-anchor="middle" font-family="Inter, sans-serif" font-size="5.4" font-weight="700" fill="currentColor" stroke="none">PDF</text>',
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

function displayName(file) {
  return file.name || hostOf(file.originUrl) || 'Untitled';
}

function renderFiles(files) {
  lastFiles = files;
  grid.innerHTML = '';
  for (const file of files) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'file-card';

    const thumb = document.createElement('div');
    thumb.className = 'file-thumb';
    const thumbUrl = bestThumbUrl(file);
    if (thumbUrl) {
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = displayName(file);
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
    name.textContent = displayName(file);

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const host = file.kind === 'bookmark' ? hostOf(file.originUrl) : null;
    meta.textContent = host && host !== name.textContent
      ? `${host} · ${formatDate(file.createdAt)}`
      : formatDate(file.createdAt);

    card.append(thumb, name, meta);

    if ((file.tags || []).length) {
      const row = document.createElement('div');
      row.className = 'card-tags';
      file.tags.slice(0, 3).forEach((t) => {
        const s = document.createElement('span');
        s.className = 'card-tag';
        s.textContent = t.name;
        row.appendChild(s);
      });
      card.appendChild(row);
    }

    card.addEventListener('click', () => openViewer(file));
    grid.appendChild(card);
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

/* ---------- loading and searching ---------- */

// The full list and a search can be in flight together, and on a sleepy
// connection the older one can answer last. Only the newest request is allowed
// to paint, otherwise a stale reply wipes out the results she just asked for.
let latestRequest = 0;

async function refresh() {
  const q = searchInput.value.trim();
  const ticket = ++latestRequest;
  let slowNotice;
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (activeTagId) params.set('tag', activeTagId);
    const url = q ? `/api/search?${params}` : `/api/files${params.toString() ? '?' + params : ''}`;

    // The free server naps, so the first call of the day can take a while.
    slowNotice = setTimeout(() => {
      if (ticket === latestRequest) busy.classList.remove('hidden');
    }, 400);

    const data = await (await fetch(url)).json();
    clearTimeout(slowNotice);
    if (ticket !== latestRequest) return;
    busy.classList.add('hidden');
    loadError.classList.add('hidden');
    if (data.error) throw new Error(data.error);

    if (Array.isArray(data.tags)) {
      knownTags = data.tags;
      renderTagBar();
      detailsPicker.refresh();
      notePicker.refresh();
      linkPicker.refresh();
    }
    renderFiles(data.files || []);
    renderMemories(data.memories || []);
    updateEmptyState((data.files || []).length, (data.memories || []).length);
  } catch (err) {
    clearTimeout(slowNotice);
    if (ticket !== latestRequest) return;
    busy.classList.add('hidden');
    console.error(err);
    // A three second message is no use with no signal and no way to reload,
    // so the way back in stays on screen until it works.
    grid.innerHTML = '';
    renderMemories([]);
    emptyState.classList.add('hidden');
    loadError.classList.remove('hidden');
  }
}

document.getElementById('load-retry').addEventListener('click', refresh);

let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(refresh, 320);
});

/* ---------- viewer ---------- */

const viewer = document.getElementById('viewer');
const viewerBody = document.getElementById('viewer-body');
const viewerName = document.getElementById('viewer-name');
const viewerMeta = document.getElementById('viewer-meta');
const viewerDownload = document.getElementById('viewer-download');

const viewerConfirm = document.getElementById('viewer-confirm');
let viewingFile = null;

function closeViewer(fromHistory = false) {
  viewer.classList.add('hidden');
  viewerBody.innerHTML = '';
  viewerConfirm.classList.add('hidden');
  viewingFile = null;
  if (!anyOverlayOpen()) document.body.classList.remove('locked');
  if (!fromHistory && !anyOverlayOpen()) dropOverlayStep();
}

document.getElementById('viewer-close').addEventListener('click', () => closeViewer());

document.getElementById('viewer-delete').addEventListener('click', () => {
  viewerConfirm.classList.remove('hidden');
});
document.getElementById('confirm-cancel').addEventListener('click', () => {
  viewerConfirm.classList.add('hidden');
});
document.getElementById('confirm-remove').addEventListener('click', async () => {
  const file = viewingFile;
  if (!file) return;
  const button = document.getElementById('confirm-remove');
  button.disabled = true;
  button.textContent = 'Removing...';
  try {
    await postJson('/api/delete', { id: file.id });
    closeViewer();
    refresh();
    showToast(`Removed ${displayName(file)}`, {
      label: 'Undo',
      run: async () => {
        try {
          await postJson('/api/restore', { id: file.id });
          showToast('Brought it back');
          refresh();
        } catch (err) {
          showToast('Could not bring it back');
        }
      },
    });
  } catch (err) {
    showToast(err.message || 'Could not remove that');
  } finally {
    button.disabled = false;
    button.textContent = 'Remove';
  }
});

let viewerTicket = 0;

async function openViewer(file) {
  const ticket = ++viewerTicket;
  viewingFile = file;
  viewerConfirm.classList.add('hidden');
  viewerName.textContent = displayName(file);
  viewerBody.innerHTML = '<div class="viewer-loading">Opening...</div>';
  viewer.classList.remove('hidden');
  document.body.classList.add('locked');
  pushOverlayStep();

  const openTarget = file.kind === 'bookmark' ? file.originUrl : file.fileUrl;
  viewerDownload.classList.toggle('hidden', !openTarget);
  if (openTarget) viewerDownload.href = openTarget;

  viewerMeta.innerHTML = '';
  // The bar at the top clips long names, so the whole name lives down here.
  const fullName = document.createElement('div');
  fullName.className = 'viewer-fullname';
  fullName.textContent = displayName(file);
  viewerMeta.appendChild(fullName);

  const bits = [];
  if (file.description) bits.push(file.description);
  if (file.size) bits.push(formatSize(file.size));
  const when = formatDate(file.createdAt);
  if (when) bits.push(when);
  const line = document.createElement('div');
  line.className = 'viewer-meta-line';
  line.textContent = bits.join(' · ');
  viewerMeta.appendChild(line);
  if ((file.tags || []).length) {
    const row = document.createElement('div');
    row.className = 'chip-row';
    file.tags.forEach((t) => {
      const s = document.createElement('span');
      s.className = 'chip chip-static';
      s.textContent = t.name;
      row.appendChild(s);
    });
    viewerMeta.appendChild(row);
  }

  try {
    if (file.kind === 'bookmark') {
      viewerBody.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'viewer-link';
      const preview = bestThumbUrl(file);
      if (preview) {
        const img = document.createElement('img');
        img.src = preview;
        img.alt = displayName(file);
        box.appendChild(img);
      }
      const host = document.createElement('p');
      host.className = 'viewer-link-host';
      host.textContent = hostOf(file.originUrl) || '';
      const go = document.createElement('a');
      go.className = 'btn btn-primary viewer-link-go';
      go.href = file.originUrl;
      go.target = '_blank';
      go.rel = 'noopener';
      go.textContent = 'Open website';
      box.append(host, go);
      viewerBody.appendChild(box);
    } else if (file.kind === 'image' && file.fileUrl) {
      viewerBody.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'viewer-image';
      img.src = (file.thumbnail && file.thumbnail.xl) || file.fileUrl;
      img.alt = displayName(file);
      viewerBody.appendChild(img);
    } else if (file.kind === 'notepad') {
      const data = await (await fetch(`/api/notes/${file.id}/content`)).json();
      // She may have closed this and opened something else while it loaded.
      if (ticket !== viewerTicket) return;
      viewerBody.innerHTML = '';
      const pre = document.createElement('div');
      pre.className = 'viewer-note';
      pre.textContent = data.text || '(This note is empty.)';
      viewerBody.appendChild(pre);
    } else if ((file.kind === 'audio' || file.kind === 'voicenote') && file.fileUrl) {
      viewerBody.innerHTML = '';
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.className = 'viewer-audio';
      audio.src = file.fileUrl;
      viewerBody.appendChild(audio);
    } else if (file.kind === 'video' && file.fileUrl) {
      viewerBody.innerHTML = '';
      const video = document.createElement('video');
      video.controls = true;
      video.className = 'viewer-video';
      video.src = file.fileUrl;
      viewerBody.appendChild(video);
    } else if (file.extension === 'pdf' && file.fileUrl) {
      viewerBody.innerHTML = '';
      const frame = document.createElement('iframe');
      frame.className = 'viewer-frame';
      frame.src = file.fileUrl;
      viewerBody.appendChild(frame);
    } else {
      viewerBody.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'viewer-fallback';
      const key = iconKeyFor(file);
      box.innerHTML = `<svg viewBox="0 0 24 24" width="52" height="52" aria-hidden="true">${ICONS[key]}</svg>`;
      const p = document.createElement('p');
      p.textContent = file.fileUrl
        ? 'Tap the arrow above to open this file.'
        : 'There is nothing to show for this one.';
      box.appendChild(p);
      viewerBody.appendChild(box);
    }
  } catch (err) {
    if (ticket !== viewerTicket) return;
    console.error(err);
    viewerBody.innerHTML = '<div class="viewer-fallback"><p>Could not open this one.</p></div>';
  }
}

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
    // Without this a stalled upload would sit at the same percentage for ever
    // instead of failing and offering to try again.
    xhr.timeout = 5 * 60 * 1000;
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
      const old = row.querySelector('.transfer-retry');
      if (old) old.remove();
      const retry = document.createElement('button');
      retry.className = 'transfer-retry';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => {
        // Reuse this row rather than removing it, so a second failure still has
        // somewhere to report itself instead of disappearing without a word.
        retry.remove();
        row.classList.remove('failed');
        row.querySelector('.transfer-bar').style.width = '0%';
        onRetry();
      });
      row.appendChild(retry);
    },
    done() {
      row.remove();
    },
  };
}

async function uploadViaServer(file, { isVoiceNote, tags, description }, ui) {
  ui.setStatus('Sending...');
  const form = new FormData();
  form.append('file', file, file.name);
  if (isVoiceNote) form.append('isVoiceNote', 'true');
  if (description) form.append('description', description);
  (tags || []).forEach((t) => form.append('tags', t));
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
}

async function uploadOne(file, details = {}) {
  const { isVoiceNote = false, tags = [], description = '' } = details;
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
        await uploadViaServer(file, { isVoiceNote, tags, description }, ui);
        ui.done();
        showToast(`Saved ${file.name}`);
        refresh();
        return;
      }

      ui.setStatus('Saving...');
      const saved = await postJson('/api/upload/commit', {
        path: presign.path,
        filename: file.name,
        mimeType: file.type,
        isVoiceNote,
        tags,
        description,
      });

      ui.done();
      showToast(saved.file && saved.file.descriptionSaved === false
        ? `Saved ${file.name}, but your note about it did not stick`
        : `Saved ${file.name}`);
      refresh();
    } catch (err) {
      console.error('Upload failed', err);
      ui.fail('Not sent', attempt);
      updateEmptyState(grid.children.length, memoryList.children.length);
    }
  };

  await attempt();
}

/* ---------- details asked before a file is sent ---------- */

let pendingFiles = [];
let pendingIsVoice = false;

function askForDetails(files, { isVoiceNote = false } = {}) {
  document.getElementById('details-description').value = '';
  detailsPicker.reset();
  document.getElementById('details-subject').textContent = files.length === 1
    ? files[0].name
    : `${files.length} files`;
  showSheet('details');
  // Set after opening: showSheet closes whatever was open, which clears pending.
  pendingFiles = files;
  pendingIsVoice = isVoiceNote;
}

async function sendPendingFiles(withDetails) {
  const description = withDetails ? document.getElementById('details-description').value.trim() : '';
  const tags = withDetails ? detailsPicker.getTags() : [];
  const files = pendingFiles;
  const isVoiceNote = pendingIsVoice;
  pendingFiles = [];
  closeSheet();

  // Three at a time: a whole camera roll sent at once just makes every one of
  // them crawl and time out on a phone connection.
  const queue = [...files];
  const worker = async () => {
    while (queue.length) {
      await uploadOne(queue.shift(), { isVoiceNote, tags, description });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

document.getElementById('details-save').addEventListener('click', () => sendPendingFiles(true));
document.getElementById('details-skip').addEventListener('click', () => sendPendingFiles(false));

function handlePickedFiles(input) {
  const files = Array.from(input.files || []);
  input.value = '';
  if (files.length) askForDetails(files);
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
  await postJson('/api/notes', {
    title: title.value, text: body.value, tags: notePicker.getTags(),
  });
  title.value = '';
  body.value = '';
  notePicker.reset();
  showToast('Note saved');
  refresh();
});

wireSaveButton('link-save', async () => {
  const url = document.getElementById('link-url');
  const description = document.getElementById('link-description');
  if (!url.value.trim()) throw new Error('Paste a link first');
  const saved = await postJson('/api/links', {
    url: url.value, description: description.value, tags: linkPicker.getTags(),
  });
  url.value = '';
  description.value = '';
  linkPicker.reset();
  showToast(saved.file && saved.file.descriptionSaved === false
    ? 'Link saved, but your note about it did not stick'
    : 'Link saved');
  refresh();
});

wireSaveButton('memory-save', async () => {
  const body = document.getElementById('memory-body');
  if (body.value.trim().length < 5) throw new Error('Write a little more to remember it');
  const { job } = await postJson('/api/memories', { text: body.value });
  body.value = '';
  // Fabric files a memory away before it can be searched for, so say so rather
  // than promising something she would then fail to find.
  showToast('Saved. It takes a few minutes before you can search for it.');
  if (job && job.id) watchMemory(job.id);
});

// Quietly checks back until the memory is ready, then says so if she is still here.
async function watchMemory(jobId) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 30000));
    try {
      const { ready } = await (await fetch(`/api/memories/${jobId}`)).json();
      if (ready) {
        showToast('That memory is ready to search for now.');
        return;
      }
    } catch (err) {
      return;
    }
  }
}

/* ---------- voice recording ---------- */

const voiceButton = document.getElementById('voice-button');
const voiceLabel = document.getElementById('voice-label');
const voiceTimer = document.getElementById('voice-timer');
const voiceHint = document.getElementById('voice-hint');
const voiceSave = document.getElementById('voice-save');

let recorder = null;
let activeStream = null;
let recordedChunks = [];
let recordedBlob = null;
let recordTimer = null;
let recordStartedAt = 0;

// The microphone stays switched on until its tracks are stopped, so this must
// run on every exit from recording, including when she simply backs out.
function releaseMic() {
  if (!activeStream) return;
  activeStream.getTracks().forEach((t) => t.stop());
  activeStream = null;
}

function tickTimer() {
  const seconds = Math.floor((Date.now() - recordStartedAt) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  voiceTimer.textContent = `${mm}:${ss}`;
}

// Phones disagree about audio formats, so try each until one is accepted.
function makeRecorder(stream) {
  const candidates = ['audio/mp4', 'audio/webm', 'audio/ogg'];
  for (const mimeType of candidates) {
    try {
      if (MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported(mimeType)) continue;
      return new MediaRecorder(stream, { mimeType });
    } catch (err) {
      /* try the next one */
    }
  }
  return new MediaRecorder(stream);
}

function setRecordingUi(on) {
  voiceButton.classList.toggle('recording', on);
  voiceButton.setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
  voiceButton.innerHTML = on
    ? '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  voiceLabel.textContent = on ? 'Stop' : 'Record';
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    voiceHint.textContent = 'This phone cannot record inside the app. Use "Record on my phone instead" below.';
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    voiceHint.textContent = err && err.name === 'NotAllowedError'
      ? 'Microphone permission was refused. Allow it in your phone settings, or use "Record on my phone instead" below.'
      : 'The microphone could not be opened. Use "Record on my phone instead" below.';
    return;
  }

  try {
    // Kept in a local name: the shared one is cleared the moment we stop, but
    // the finished audio only arrives afterwards and still needs this handle.
    const rec = makeRecorder(stream);
    recorder = rec;
    activeStream = stream;
    recordedChunks = [];
    recordedBlob = null;

    const finish = () => {
      releaseMic();
      if (!recordedChunks.length) {
        voiceHint.textContent = 'Nothing was recorded. Please try once more.';
        voiceTimer.textContent = 'Tap to start';
        return;
      }
      recordedBlob = new Blob(recordedChunks, { type: rec.mimeType || 'audio/webm' });
      voiceSave.disabled = false;
      voiceHint.textContent = 'Ready to save. Tap Record to do it again.';
    };

    rec.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    rec.onstop = finish;
    rec.onerror = () => {
      clearInterval(recordTimer);
      recordTimer = null;
      recorder = null;
      releaseMic();
      setRecordingUi(false);
      voiceTimer.textContent = 'Tap to start';
      voiceHint.textContent = 'The recording stopped unexpectedly. Please try again.';
    };

    // Ask for the audio in pieces so nothing depends on one final delivery.
    rec.start(1000);
    recordStartedAt = Date.now();
    tickTimer();
    recordTimer = setInterval(tickTimer, 500);
    setRecordingUi(true);
    voiceHint.textContent = 'Recording. Tap the square to stop.';
    voiceSave.disabled = true;
  } catch (err) {
    console.error('Recorder failed', err);
    stream.getTracks().forEach((t) => t.stop());
    voiceHint.textContent = 'This phone would not start recording. Use "Record on my phone instead" below.';
  }
}

function stopRecording(discard = false) {
  clearInterval(recordTimer);
  recordTimer = null;
  setRecordingUi(false);
  const rec = recorder;
  recorder = null;
  if (rec && rec.state === 'recording') {
    if (discard) rec.onstop = null;
    try { rec.stop(); } catch (err) { /* already stopped */ }
  }
  if (discard) releaseMic();
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

// Always available: the phone's own recorder, for anything the browser refuses.
document.getElementById('voice-fallback').addEventListener('click', () => {
  document.getElementById('audio-input').click();
});
document.getElementById('audio-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  closeSheet();
  setTimeout(() => askForDetails(files, { isVoiceNote: true }), 200);
});

voiceSave.addEventListener('click', () => {
  if (!recordedBlob) return;
  const ext = (recordedBlob.type.includes('mp4') && 'm4a')
    || (recordedBlob.type.includes('ogg') && 'ogg')
    || 'webm';
  const stamp = new Date().toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).replace(/[,:]/g, '').replace(/\s+/g, '-');
  const blob = recordedBlob;
  const file = new File([blob], `Voice-${stamp}.${ext}`, { type: blob.type });
  recordedBlob = null;
  closeSheet();
  setTimeout(() => askForDetails([file], { isVoiceNote: true }), 200);
});

/* ---------- start ---------- */

refresh();

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

  // A new version takes over as soon as it is ready. Reloading once here means
  // she is never left running old code against a newer cabinet.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}
