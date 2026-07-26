const express = require('express');
const multer = require('multer');
const path = require('path');
const fabric = require('./fabric');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const FOLDER_NAME = process.env.FABRIC_FOLDER_NAME || 'Shweta';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

function fail(res, err, message) {
  console.error(message, err);
  res.status(500).json({ error: message });
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/files', async (req, res) => {
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    res.json({ files: await fabric.listRecent(folderId) });
  } catch (err) {
    fail(res, err, 'Could not load your files');
  }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ files: [], memories: [] });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const [files, memories] = await Promise.all([
      fabric.search(q, folderId),
      fabric.searchMemories(q).catch(() => []),
    ]);
    res.json({ files, memories });
  } catch (err) {
    fail(res, err, 'Search did not work');
  }
});

// The browser sends bytes straight to storage, so it asks us for a signed link
// first and tells us to register the file once the bytes have landed.
app.post('/api/upload/presign', async (req, res) => {
  const { filename, size } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'Missing file name' });
  try {
    res.json(await fabric.presignUpload(filename, Number(size)));
  } catch (err) {
    fail(res, err, 'Could not start the upload');
  }
});

app.post('/api/upload/commit', async (req, res) => {
  const { path: storagePath, filename, mimeType, isVoiceNote } = req.body || {};
  if (!storagePath || !filename) return res.status(400).json({ error: 'Missing upload details' });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const file = await fabric.registerFile({
      path: storagePath,
      filename,
      mimeType,
      parentId: folderId,
      isVoiceNote: !!isVoiceNote,
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
    });
    res.status(201).json({ file });
  } catch (err) {
    fail(res, err, 'Upload failed');
  }
});

app.post('/api/notes', async (req, res) => {
  const { title, text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Write something first' });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const name = (title || '').trim() || text.trim().split('\n')[0].slice(0, 60);
    const note = await fabric.createNote({ name, text, parentId: folderId });
    res.status(201).json({ file: note });
  } catch (err) {
    fail(res, err, 'Could not save the note');
  }
});

app.post('/api/links', async (req, res) => {
  let { url } = req.body || {};
  url = (url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    url = /^\S+\.\S+/.test(url) ? `https://${url}` : '';
  }
  if (!url) return res.status(400).json({ error: 'That does not look like a link' });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const bookmark = await fabric.createBookmark({ url, parentId: folderId });
    res.status(201).json({ file: bookmark });
  } catch (err) {
    fail(res, err, 'Could not save the link');
  }
});

app.post('/api/memories', async (req, res) => {
  const { text, title } = req.body || {};
  if (!text || text.trim().length < 5) {
    return res.status(400).json({ error: 'Write a little more to remember it' });
  }
  try {
    const job = await fabric.createMemory({ name: (title || '').trim() || null, content: text.trim() });
    res.status(201).json({ job });
  } catch (err) {
    fail(res, err, 'Could not remember that');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Shweta's Cabinet listening on ${port}`));
