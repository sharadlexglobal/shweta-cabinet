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
// Returns false when the words did not stick, so she can be told rather than
// left believing they were saved. The file itself is never lost either way.
async function applyDescription(resourceId, description) {
  const text = (typeof description === 'string' ? description : '').trim();
  if (!text) return true;
  try {
    await fabricFetch(`/v2/resources/${resourceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: text.slice(0, 2000) }),
    });
    return true;
  } catch (err) {
    console.error('Could not attach the description', err && err.message);
    return false;
  }
}

/* ---------- uploads ---------- */

// Storage path Fabric hands back inside a presigned URL. The browser PUTs the
// bytes straight to that URL, then asks us to register the file, so we check the
// shape of the path we're given before trusting it.
const STORAGE_PATH = /^workspace\/[0-9a-f-]{36}\/resource\/[0-9a-f-]{36}\/v0\/[^/]+$/i;

// Paths we handed out, so a caller cannot ask us to attach somebody else's
// stored file to this cabinet by naming their storage path instead.
const issuedPaths = new Map();
const PATH_VALID_FOR = 30 * 60 * 1000;

function rememberPath(path) {
  issuedPaths.set(path, Date.now());
  for (const [key, at] of issuedPaths) {
    if (Date.now() - at > PATH_VALID_FOR) issuedPaths.delete(key);
  }
}

async function presignUpload(filename, size) {
  // Fabric refuses the request outright if size is missing, and a phone does
  // not always know how big a file is (anything picked from cloud storage), so
  // an unknown size is sent as zero rather than left out.
  const query = new URLSearchParams({
    filename,
    size: String(Number.isFinite(size) && size >= 0 ? size : 0),
  });
  const presign = await fabricFetch(`/v2/upload?${query}`);
  const path = new URL(presign.url).pathname.replace(/^\//, '');
  rememberPath(path);
  return { url: presign.url, headers: presign.headers, path };
}

async function registerFile({ path, filename, mimeType, parentId, isVoiceNote, tags, description }) {
  if (!STORAGE_PATH.test(path)) throw new Error('Unexpected storage path');
  if (!issuedPaths.has(path)) throw new Error('That upload was not started here');
  issuedPaths.delete(path);
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
  file.descriptionSaved = await applyDescription(file.id, description);
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

// Every id that reaches Fabric is checked here first. Without this a caller
// could put path separators in an id and reach any endpoint of the workspace.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertId(resourceId) {
  if (typeof resourceId !== 'string' || !UUID.test(resourceId)) {
    throw new Error('Not a valid item id');
  }
  return resourceId;
}

async function assertInFolder(resourceId, parentId) {
  const resource = await getResource(assertId(resourceId));
  const belongsHere = (resource.parent && resource.parent.id === parentId)
    || (resource.root && resource.root.id === parentId);
  if (!belongsHere) throw new Error('That item does not belong to this cabinet');
  return resource;
}

// Fabric treats a single line break as a soft wrap inside one paragraph, so a
// shopping list typed on separate lines comes back as one run-on sentence. Each
// line is stored as its own paragraph, and read back the way she typed it.
function toParagraphs(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n\n');
}

function fromParagraphs(text) {
  return String(text || '').replace(/\n{2,}/g, '\n');
}

async function createNote({ name, text, parentId, tags, description }) {
  const note = await fabricFetch('/v2/notepads', {
    method: 'POST',
    body: JSON.stringify({
      name, parentId, text: toParagraphs(text),
      ...(tagPayload(tags) ? { tags: tagPayload(tags) } : {}),
    }),
  });
  note.descriptionSaved = await applyDescription(note.id, description);
  return note;
}

async function getNoteContent(resourceId, parentId) {
  await assertInFolder(resourceId, parentId);
  const text = await fabricFetch(`/v2/notepads/${resourceId}/content`);
  return fromParagraphs(typeof text === 'string' ? text : '');
}

async function createBookmark({ url, parentId, tags, description }) {
  const bookmark = await fabricFetch('/v2/bookmarks', {
    method: 'POST',
    body: JSON.stringify({
      url, parentId,
      ...(tagPayload(tags) ? { tags: tagPayload(tags) } : {}),
    }),
  });
  bookmark.descriptionSaved = await applyDescription(bookmark.id, description);
  return bookmark;
}

// Fabric keeps memories for the whole workspace with no folder to scope them
// to, so each one saved here is stamped and only stamped ones are ever shown.
// Without this, searching would surface the workspace owner's private memories.
const MEMORY_STAMP = '[cabinet]';

async function createMemory({ name, content }) {
  const stamped = `${MEMORY_STAMP} ${(name || '').trim() || content.trim().slice(0, 50)}`;
  return fabricFetch('/v2/memories', {
    method: 'POST',
    body: JSON.stringify({ source: 'text', content, name: stamped.slice(0, 255) }),
  });
}

// A memory is filed away in two steps: the job finishes, and only later is the
// memory indexed. It cannot be searched for until both are done.
async function memoryReady(jobId) {
  const job = await fabricFetch(`/v2/memories/jobs/${assertId(jobId)}`);
  if (job.status !== 'completed') return false;
  const created = ((job.memories || {}).created) || [];
  if (!created.length) return false;
  const states = await Promise.all(
    created.map((id) => fabricFetch(`/v2/memories/${id}`).then((m) => !!m.indexed).catch(() => false))
  );
  return states.every(Boolean);
}

// Memory search hands back every memory every time, with the near-misses
// sitting on a flat baseline score. A real match scores several times higher,
// so anything close to that baseline is dropped rather than shown as a result.
const MEMORY_MATCH_FLOOR = 15;

async function searchMemories(query) {
  const data = await fabricFetch(`/v2/memories/search?query=${encodeURIComponent(query)}`);
  const ours = (data.hits || []).filter(
    (h) => typeof h.name === 'string' && h.name.startsWith(MEMORY_STAMP)
  );
  if (!ours.length) return [];

  let lowest = Infinity;
  for (const h of ours) lowest = Math.min(lowest, h.score || 0);

  return ours
    .filter((h) => {
      const score = h.score || 0;
      if (score < MEMORY_MATCH_FLOOR) return false;
      return ours.length === 1 || score >= lowest * 1.5;
    })
    .map((h) => ({ ...h, name: h.name.slice(MEMORY_STAMP.length).trim() }));
}

/* ---------- listing, tags, search ---------- */

// Fabric answers a filter with one page at a time — twenty by default — and
// hands back a cursor for the next one. Asking once would quietly hide
// everything past the first page, so we walk the pages until they run out.
const PAGE_SIZE = 100;
const NEWEST_FIRST = { property: 'createdAt', direction: 'DESC' };

async function listPages(filter, cap) {
  const collected = [];
  let cursor = null;
  do {
    const page = await fabricFetch('/v2/resources/filter', {
      method: 'POST',
      body: JSON.stringify({
        ...filter,
        limit: PAGE_SIZE,
        order: NEWEST_FIRST,
        ...(cursor ? { cursor } : {}),
      }),
    });
    collected.push(...(page.resources || []));
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor && collected.length < cap);
  return collected.slice(0, cap);
}

async function listRecent(parentId, limit = 1000) {
  return listPages({ parentId }, limit);
}

// Only the tags actually used inside this folder. The workspace-wide tag list
// would expose names from other people's work, which must never show up here.
async function listFolderTags(parentId) {
  const resources = await listRecent(parentId, 2000);
  const seen = new Map();
  for (const r of resources) {
    for (const tag of r.tags || []) {
      if (tag && tag.id && !seen.has(tag.id)) seen.set(tag.id, { id: tag.id, name: tag.name });
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function listByTag(parentId, tagId, limit = 1000) {
  return listPages({ parentId, tagIds: [tagId] }, limit);
}

async function getResource(resourceId) {
  return fabricFetch(`/v2/resources/${resourceId}`);
}

// Always archive rather than erase: Fabric deletes for good by default, and a
// tap in this app must never be the last word on somebody's document.
async function removeResource(resourceId, parentId) {
  const resource = await assertInFolder(resourceId, parentId);
  await fabricFetch('/v2/resources/delete', {
    method: 'POST',
    body: JSON.stringify({ resourceIds: [resourceId], archive: true }),
  });
  archivedHere.add(resourceId);
  return resource;
}

// Only things this app archived may be brought back. An archived item cannot be
// re-checked against the folder, so the record of having removed it is the gate.
const archivedHere = new Set();

async function restoreResource(resourceId) {
  assertId(resourceId);
  if (!archivedHere.has(resourceId)) {
    throw new Error('That item was not removed from this cabinet');
  }
  await fabricFetch('/v2/resources/recover', {
    method: 'POST',
    body: JSON.stringify({ resourceIds: [resourceId] }),
  });
  archivedHere.delete(resourceId);
}

async function search(query, parentId, tagId) {
  const filters = { parentIds: [parentId] };
  if (tagId) filters.tagIds = [tagId];

  const [semantic, byName] = await Promise.all([
    fabricFetch('/v2/search', {
      method: 'POST',
      body: JSON.stringify({ text: query, filters }),
    }).catch(() => ({ hits: [] })),
    listPages({ parentId, name: query, ...(tagId ? { tagIds: [tagId] } : {}) }, 200)
      .catch(() => []),
  ]);

  const merged = new Map();
  for (const r of semantic.hits || []) merged.set(r.id, r);
  for (const r of byName) merged.set(r.id, r);
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
  memoryReady,
  searchMemories,
  listRecent,
  listFolderTags,
  listByTag,
  search,
  getResource,
  removeResource,
  restoreResource,
};
