const express = require('express');
const multer = require('multer');
const path = require('path');
const fabric = require('./fabric');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const FOLDER_NAME = process.env.FABRIC_FOLDER_NAME || 'Shweta';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/files', async (req, res) => {
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const files = await fabric.listRecent(folderId);
    res.json({ files });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load files' });
  }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ files: [] });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const files = await fabric.search(q, folderId);
    res.json({ files });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  try {
    const folderId = await fabric.ensureFolder(FOLDER_NAME);
    const created = await fabric.uploadFile({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      parentId: folderId,
    });
    res.status(201).json({ file: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Shweta's Cabinet listening on ${port}`));
