const FABRIC_BASE = 'https://api.fabric.so';

function apiKey() {
  const key = process.env.FABRIC_API_KEY;
  if (!key) throw new Error('FABRIC_API_KEY is not set');
  return key;
}

async function fabricFetch(path, options = {}) {
  const res = await fetch(FABRIC_BASE + path, {
    ...options,
    headers: {
      'X-Api-Key': apiKey(),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fabric ${options.method || 'GET'} ${path} failed: ${res.status} ${text}`);
  }
  if (res.status === 204) return null;
  // Fabric answers with application/hal+json, so match on "json" broadly.
  // Notepad content comes back as plain text.
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

let cachedFolderId = process.env.FABRIC_FOLDER_ID || null;

// Finds the configured folder by name, creating it if it does not exist yet.
// Cached in memory for the process lifetime so we don't repeat the lookup.
async function ensureFolder(name) {
  if (cachedFolderId) return cachedFolderId;

  const existing = await fabricFetch('/v2/resources/filter', {
    method: 'POST',
    body: JSON.stringify({ kind: ['folder'], name }),
  });
  const exact = (existing.resources || []).find(
    (r) => r.name.toLowerCase() === name.toLowerCase()
  );
  if (exact) {
    cachedFolderId = exact.id;
    return cachedFolderId;
  }

  const created = await fabricFetch('/v2/folders', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  cachedFolderId = created.id;
  return cachedFolderId;
}

function tagPayload(tags) {
  if (!Array.isArray(tags)) return undefined;
  const names = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
  return names.length ? names.map((name) => ({ name: name.slice(0, 255) })) : undefined;
}

// Descriptions are not accepted while creating a resource, so they are applied
// straight afterwards. A failure here must not lose the thing she just saved.
async function applyDescription(resourceId, description) {
  const text = (description || '').trim();
  if (!text) return;
  try {
    await fabricFetch(`/v2/resources/${resourceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: text.slice(0, 2000) }),
    });
  } catch (err) {
    console.error('Could not attach the description', err);
  }
}

/* ---------- uploads ---------- */

// Storage path Fabric hands back inside a presigned URL. The browser PUTs the
// bytes straight to that URL, then asks us to register the file, so we check the
// shape of the path we're given before trusting it.
const STORAGE_PATH = /^workspace\/[0-9a-f-]{36}\/resource\/[0-9a-f-]{36}\/v0\/[^/]+$/i;

async function presignUpload(filename, size) {
  const query = new URLSearchParams({ filename });
  if (Number.isFinite(size)) query.set('size', String(size));
  const presign = await fabricFetch(`/v2/upload?${query}`);
  return {
    url: presign.url,
    headers: presign.headers,
    path: new URL(presign.url).pathname.replace(/^\//, ''),
  };
}

async function registerFile({ path, filename, mimeType, parentId, isVoiceNote, tags, description }) {
  if (!STORAGE_PATH.test(path)) throw new Error('Unexpected storage path');
  const file = await fabricFetch('/v2/files', {
    method: 'POST',
    body: JSON.stringify({
      name: filename,
      parentId,
      mimeType: mimeType || 'application/octet-stream',
      attachment: { path, filename },
      ...(tagPayload(tags) ? { tags: tagPayload(tags) } : {}),
      ...(isVoiceNote ? { metadata: { voiceNote: true } } : {}),
    }),
  });
  await applyDescription(file.id, description);
  return file;
}

// Server-side upload, used as a fallback when the browser cannot PUT directly.
async function uploadFile({ buffer, filename, mimeType, parentId, isVoiceNote, tags, description }) {
  const presign = await presignUpload(filename, buffer.length);
  const putRes = await fetch(presign.url, {
    method: 'PUT',
    headers: presign.headers,
    body: buffer,
  });
  if (!putRes.ok) throw new Error(`Upload PUT failed: ${putRes.status}`);
  return registerFile({
    path: presign.path, filename, mimeType, parentId, isVoiceNote, tags, description,
  });
}

/* ---------- notes, links, memories ---------- */

async function createNote({ name, text, parentId, tags, description }) {
  const note = await fabricFetch('/v2/notepads', {
    method: 'POST',
    body: JSON.stringify({
      name, parentId, text,
      ...(tagPayload(tags) ? { tags: tagPayload(tags) } : {}),
    }),
  });
  await applyDescription(note.id, description);
  return note;
}

async function getNoteContent(resourceId) {
  return fabricFetch(`/v2/notepads/${resourceId}/content`);
}

async function createBookmark({ url, parentId, tags, description }) {
  const bookmark = await fabricFetch('/v2/bookmarks', {
    method: 'POST',
    body: JSON.stringify({
      url, parentId,
      ...(tagPayload(tags) ? { tags: tagPayload(tags) } : {}),
    }),
  });
  await applyDescription(bookmark.id, description);
  return bookmark;
}

async function createMemory({ name, content }) {
  return fabricFetch('/v2/memories', {
    method: 'POST',
    body: JSON.stringify({ source: 'text', content, ...(name ? { name } : {}) }),
  });
}

// Memory search hands back every memory every time, with the near-misses
// sitting on a flat baseline score. A real match scores several times higher,
// so anything close to that baseline is dropped rather than shown as a result.
const MEMORY_MATCH_FLOOR = 15;

async function searchMemories(query) {
  const data = await fabricFetch(`/v2/memories/search?query=${encodeURIComponent(query)}`);
  const hits = data.hits || [];
  if (!hits.length) return [];

  const lowest = Math.min(...hits.map((h) => h.score || 0));
  return hits.filter((h) => {
    const score = h.score || 0;
    if (score < MEMORY_MATCH_FLOOR) return false;
    return hits.length === 1 || score >= lowest * 1.5;
  });
}

/* ---------- listing, tags, search ---------- */

async function listRecent(parentId, limit = 100) {
  const data = await fabricFetch('/v2/resources/filter', {
    method: 'POST',
    body: JSON.stringify({ parentId }),
  });
  const resources = data.resources || [];
  resources.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return resources.slice(0, limit);
}

// Only the tags actually used inside this folder. The workspace-wide tag list
// would expose names from other people's work, which must never show up here.
async function listFolderTags(parentId) {
  const resources = await listRecent(parentId, 500);
  const seen = new Map();
  for (const r of resources) {
    for (const tag of r.tags || []) {
      if (tag && tag.id && !seen.has(tag.id)) seen.set(tag.id, { id: tag.id, name: tag.name });
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function listByTag(parentId, tagId) {
  const data = await fabricFetch('/v2/resources/filter', {
    method: 'POST',
    body: JSON.stringify({ parentId, tagIds: [tagId] }),
  });
  const resources = data.resources || [];
  resources.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return resources;
}

async function getResource(resourceId) {
  return fabricFetch(`/v2/resources/${resourceId}`);
}

// Always archive rather than erase: Fabric deletes for good by default, and a
// tap in this app must never be the last word on somebody's document.
async function removeResource(resourceId, parentId) {
  const resource = await getResource(resourceId);
  const belongsHere = (resource.parent && resource.parent.id === parentId)
    || (resource.root && resource.root.id === parentId);
  if (!belongsHere) throw new Error('That item does not belong to this cabinet');

  await fabricFetch('/v2/resources/delete', {
    method: 'POST',
    body: JSON.stringify({ resourceIds: [resourceId], archive: true }),
  });
  return resource;
}

async function restoreResource(resourceId) {
  await fabricFetch('/v2/resources/recover', {
    method: 'POST',
    body: JSON.stringify({ resourceIds: [resourceId] }),
  });
}

async function search(query, parentId, tagId) {
  const filters = { parentIds: [parentId] };
  if (tagId) filters.tagIds = [tagId];

  const [semantic, byName] = await Promise.all([
    fabricFetch('/v2/search', {
      method: 'POST',
      body: JSON.stringify({ text: query, filters }),
    }).catch(() => ({ hits: [] })),
    fabricFetch('/v2/resources/filter', {
      method: 'POST',
      body: JSON.stringify({ parentId, name: query, ...(tagId ? { tagIds: [tagId] } : {}) }),
    }).catch(() => ({ resources: [] })),
  ]);

  const merged = new Map();
  for (const r of semantic.hits || []) merged.set(r.id, r);
  for (const r of byName.resources || []) merged.set(r.id, r);
  return Array.from(merged.values());
}

module.exports = {
  ensureFolder,
  presignUpload,
  registerFile,
  uploadFile,
  createNote,
  getNoteContent,
  createBookmark,
  createMemory,
  searchMemories,
  listRecent,
  listFolderTags,
  listByTag,
  search,
  getResource,
  removeResource,
  restoreResource,
};
