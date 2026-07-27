const express = require('express');
const multer = require('multer');
const path = require('path');
const fabric = require('./fabric');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const FOLDER_NAME = process.env.FABRIC_FOLDER_NAME || 'Shweta';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// A rejected request must never be reported as a server fault, and a caller
// sending the wrong sort of value must never be able to stop the app.
const REFUSALS = ['does not belong', 'not a valid item id', 'was not removed', 'not started here'];

function fail(res, err, message) {
  const reason = (err && err.message) || '';
  if (REFUSALS.some((r) => reason.toLowerCase().includes(r))) {
    return res.status(400).json({ error: 'That is not something this cabinet can open' });
  }
  console.error(message, reason);
  res.status(500).json({ error: message });
}

// Anything from the network may be a number, an object or missing entirely.
function asText(value, max = 5000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseTags(raw) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  return list.filter((t) => typeof t === 'string').slice(0, 12);
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/files', async (req, res) => {
  const tagId = (req.query.tag || '').toString().trim();
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const [files, tags] = await Promise.all([
      tagId ? fabric.listByTag(folderId, tagId) : fabric.listRecent(folderId),
      fabric.listFolderTags(folderId).catch(() => []),
    ]);
    res.json({ files, tags });
  } catch (err) {
    fail(res, err, 'Could not load your files');
  }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const tagId = (req.query.tag || '').toString().trim();
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    if (!q) {
      const files = tagId ? await fabric.listByTag(folderId, tagId) : await fabric.listRecent(folderId);
      return res.json({ files, memories: [] });
    }
    const [files, memories] = await Promise.all([
      fabric.search(q, folderId, tagId),
      fabric.searchMemories(q).catch(() => []),
    ]);
    res.json({ files, memories });
  } catch (err) {
    fail(res, err, 'Search did not work');
  }
});

app.get('/api/notes/:id/content', async (req, res) => {
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const text = await fabric.getNoteContent(req.params.id, folderId);
    res.json({ text: typeof text === 'string' ? text : '' });
  } catch (err) {
    fail(res, err, 'Could not open that note');
  }
});

// The browser sends bytes straight to storage, so it asks us for a signed link
// first and tells us to register the file once the bytes have landed.
app.post('/api/upload/presign', async (req, res) => {
  const filename = asText((req.body || {}).filename, 255).replace(/[/\\]/g, '_');
  const size = Number((req.body || {}).size);
  if (!filename) return res.status(400).json({ error: 'Missing file name' });
  try {
    res.json(await fabric.presignUpload(filename, Number.isFinite(size) ? size : undefined));
  } catch (err) {
    fail(res, err, 'Could not start the upload');
  }
});

app.post('/api/upload/commit', async (req, res) => {
  const { isVoiceNote, tags } = req.body || {};
  const storagePath = asText((req.body || {}).path, 500);
  const filename = asText((req.body || {}).filename, 255).replace(/[/\\]/g, '_');
  if (!storagePath || !filename) return res.status(400).json({ error: 'Missing upload details' });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const file = await fabric.registerFile({
      path: storagePath,
      filename,
      mimeType: asText((req.body || {}).mimeType, 200),
      parentId: folderId,
      isVoiceNote: !!isVoiceNote,
      tags: parseTags(tags),
      description: asText((req.body || {}).description, 2000),
    });
    res.status(201).json({ file });
  } catch (err) {
    fail(res, err, 'The file reached storage but could not be saved');
  }
});

// Fallback for browsers that cannot send bytes straight to storage.
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const file = await fabric.uploadFile({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      parentId: folderId,
      isVoiceNote: req.body.isVoiceNote === 'true',
      tags: parseTags(req.body.tags),
      description: req.body.description,
    });
    res.status(201).json({ file });
  } catch (err) {
    fail(res, err, 'Upload failed');
  }
});

app.post('/api/notes', async (req, res) => {
  const { title, tags, description } = req.body || {};
  const text = asText((req.body || {}).text, 200000);
  if (!text) return res.status(400).json({ error: 'Write something first' });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const name = asText(title, 200) || text.split('\n')[0].slice(0, 60);
    const note = await fabric.createNote({
      name, text, parentId: folderId, tags: parseTags(tags), description: asText(description, 2000),
    });
    res.status(201).json({ file: note });
  } catch (err) {
    fail(res, err, 'Could not save the note');
  }
});

app.post('/api/links', async (req, res) => {
  const { tags, description } = req.body || {};
  let url = asText((req.body || {}).url, 2000);
  if (!/^https?:\/\/\S+$/i.test(url)) {
    // Only a bare address may have https:// put in front of it. Anything that
    // already names a different scheme is refused rather than mangled.
    url = /^\S+\.\S+$/.test(url) && !url.includes('://') ? `https://${url}` : '';
  }
  if (!url) return res.status(400).json({ error: 'That does not look like a link' });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const bookmark = await fabric.createBookmark({
      url, parentId: folderId, tags: parseTags(tags), description: asText(description, 2000),
    });
    res.status(201).json({ file: bookmark });
  } catch (err) {
    fail(res, err, 'Could not save the link');
  }
});

// Removal only ever moves the item to Fabric's trash, so "Undo" can bring it
// straight back and nothing is lost to a mistaken tap.
app.post('/api/delete', async (req, res) => {
  const id = asText((req.body || {}).id, 100);
  if (!id) return res.status(400).json({ error: 'Nothing to remove' });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const removed = await fabric.removeResource(id, folderId);
    res.json({ removed: { id: removed.id, name: removed.name } });
  } catch (err) {
    fail(res, err, 'Could not remove that');
  }
});

app.post('/api/restore', async (req, res) => {
  const id = asText((req.body || {}).id, 100);
  if (!id) return res.status(400).json({ error: 'Nothing to bring back' });
  try {
    await fabric.restoreResource(id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Could not bring it back');
  }
});

app.post('/api/memories', async (req, res) => {
  const text = asText((req.body || {}).text, 20000);
  if (text.length < 5) {
    return res.status(400).json({ error: 'Write a little more to remember it' });
  }
  try {
    const job = await fabric.createMemory({ name: asText((req.body || {}).title, 200), content: text });
    res.status(201).json({ job });
  } catch (err) {
    fail(res, err, 'Could not remember that');
  }
});

app.get('/api/memories/:jobId', async (req, res) => {
  try {
    res.json({ ready: await fabric.memoryReady(req.params.jobId) });
  } catch (err) {
    fail(res, err, 'Could not check that memory');
  }
});

// Last line of defence: one malformed request must never take the cabinet down.
app.use((err, req, res, next) => {
  console.error('Unhandled request error', err && err.message);
  if (res.headersSent) return next(err);
  res.status(400).json({ error: 'That request could not be understood' });
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection', err && err.message);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Shweta's Cabinet listening on ${port}`));
