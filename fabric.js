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
  return res.json();
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

async function uploadFile({ buffer, filename, mimeType, parentId }) {
  const presign = await fabricFetch(
    `/v2/upload?filename=${encodeURIComponent(filename)}&size=${buffer.length}`
  );

  const putRes = await fetch(presign.url, {
    method: 'PUT',
    headers: presign.headers,
    body: buffer,
  });
  if (!putRes.ok) {
    throw new Error(`Upload PUT failed: ${putRes.status}`);
  }

  const path = new URL(presign.url).pathname.replace(/^\//, '');

  return fabricFetch('/v2/files', {
    method: 'POST',
    body: JSON.stringify({
      name: filename,
      parentId,
      mimeType: mimeType || 'application/octet-stream',
      attachment: { path, filename },
    }),
  });
}

async function listRecent(parentId, limit = 60) {
  const data = await fabricFetch('/v2/resources/filter', {
    method: 'POST',
    body: JSON.stringify({ parentId }),
  });
  const resources = data.resources || [];
  resources.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return resources.slice(0, limit);
}

async function search(query, parentId) {
  const [semantic, byName] = await Promise.all([
    fabricFetch('/v2/search', {
      method: 'POST',
      body: JSON.stringify({ text: query, filters: { parentIds: [parentId] } }),
    }).catch(() => ({ hits: [] })),
    fabricFetch('/v2/resources/filter', {
      method: 'POST',
      body: JSON.stringify({ parentId, name: query }),
    }).catch(() => ({ resources: [] })),
  ]);

  const merged = new Map();
  for (const r of semantic.hits || []) merged.set(r.id, r);
  for (const r of byName.resources || []) merged.set(r.id, r);
  return Array.from(merged.values());
}

module.exports = { ensureFolder, uploadFile, listRecent, search };
