const grid = document.getElementById('file-grid');
const emptyState = document.getElementById('empty-state');
const searchInput = document.getElementById('search-input');
const fab = document.getElementById('upload-fab');
const fileInput = document.getElementById('file-input');
const toast = document.getElementById('toast');

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

const ICONS = {
  pdf: '<path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.6 17v-3.4h.9c.6 0 1 .5 1 1.1v1.2c0 .6-.4 1.1-1 1.1h-.9Zm3.6 0v-3.4h1.5M12.2 15.2h1.2m2.1 1.8v-3.4h1.5" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  document: '<path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 13h6M9 16h6M9 10h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  video: '<rect x="3" y="6" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M17 10.5l4-2.3v7.6l-4-2.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  audio: '<circle cx="8" cy="17" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="15" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.6 17V6.8L19.6 5v10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4c.4 0 .8.2 1.1.5l1.3 1.5H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  default: '<path d="M7 3h10l3 3v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M17 3v3h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
};

function iconKeyFor(file) {
  if (file.kind === 'video') return 'video';
  if (file.kind === 'audio') return 'audio';
  if (file.kind === 'folder') return 'folder';
  if (file.extension === 'pdf') return 'pdf';
  if (file.kind === 'document') return 'document';
  return 'default';
}

function iconSvg(key) {
  return `<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">${ICONS[key] || ICONS.default}</svg>`;
}

function bestThumbUrl(file) {
  if (file.kind !== 'image') return null;
  const t = file.thumbnail;
  return (t && (t.md || t.sm || t.lg)) || file.fileUrl || null;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function renderFiles(files) {
  grid.innerHTML = '';
  emptyState.classList.toggle('hidden', files.length > 0);
  for (const file of files) {
    const a = document.createElement('a');
    a.className = 'file-card';
    a.href = file.url || '#';
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
      thumb.appendChild(img);
    } else {
      thumb.classList.add('icon-' + iconKeyFor(file));
      thumb.innerHTML = iconSvg(iconKeyFor(file));
    }

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = file.name;

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = formatDate(file.createdAt);

    a.append(thumb, name, meta);
    grid.appendChild(a);
  }
}

async function loadRecent() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    renderFiles(data.files || []);
  } catch (err) {
    console.error(err);
  }
}

let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  searchDebounce = setTimeout(async () => {
    if (!q) return loadRecent();
    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      renderFiles(data.files || []);
    } catch (err) {
      console.error(err);
    }
  }, 320);
});

fab.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;
  fab.classList.add('busy');
  let okCount = 0;
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error('upload failed');
      okCount++;
    } catch (err) {
      console.error(err);
    }
  }
  fab.classList.remove('busy');
  fileInput.value = '';
  showToast(okCount === files.length ? `Saved ${okCount} file${okCount > 1 ? 's' : ''}` : `Saved ${okCount} of ${files.length}`);
  loadRecent();
});

loadRecent();

// iOS Safari has no install prompt event, so show a manual one-time tip.
(function iosInstallTip() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  const dismissed = localStorage.getItem('installTipDismissed');
  if (isIos && !isStandalone && !dismissed) {
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
