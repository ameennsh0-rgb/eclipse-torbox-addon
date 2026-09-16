require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Enable CORS for Eclipse
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const PORT = process.env.PORT || 10000;
const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const TORBOX_BASE = 'https://api.torbox.app/v1/api/torrents';

// 1. MANIFEST ENDPOINT
app.get('/manifest.json', (req, res) => {
  res.json({
    id: "com.user.torbox.flac",
    name: "Torbox FLAC Engine",
    version: "1.0.0",
    description: "Streams high-fidelity FLAC audio from torrents via Torbox CDN",
    resources: ["search", "stream"],
    types: ["track"],
    contentType: "music"
  });
});

// 2. SEARCH ENDPOINT (BitSearch API)
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ tracks: [] });

  console.log(`\n🔎 Searching torrents for: "${query}"`);

  try {
    // Query BitSearch for FLAC releases
    const searchUrl = `https://bitsearch.to/api/v1/search?q=${encodeURIComponent(query + ' flac')}&category=2`;
    const response = await axios.get(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 8000
    });

    const results = response.data?.results || [];

    if (results.length === 0) {
      console.log(`ℹ️ No direct FLAC hits. Trying general query...`);
      const fallbackUrl = `https://bitsearch.to/api/v1/search?q=${encodeURIComponent(query)}`;
      const fallbackRes = await axios.get(fallbackUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 8000
      });
      results.push(...(fallbackRes.data?.results || []));
    }

    const tracks = results.slice(0, 10).map(item => {
      if (!item.magnet) return null;
      return {
        id: Buffer.from(item.magnet).toString('base64'),
        title: item.title,
        artist: "Torrent Source",
        album: "FLAC Release",
        format: "flac"
      };
    }).filter(Boolean);

    console.log(`✅ Found ${tracks.length} track(s)`);
    res.json({ tracks });

  } catch (err) {
    console.error("❌ Search Exception:", err.message);
    res.json({ tracks: [] });
  }
});

// 3. STREAM ENDPOINT (Torbox CDN Link)
app.get('/stream/:id', async (req, res) => {
  try {
    const magnetLink = Buffer.from(req.params.id, 'base64').toString('utf-8');
    console.log(`\n▶️ Requesting stream for magnet...`);

    const headers = { Authorization: `Bearer ${TORBOX_API_KEY}` };

    // Step A: Add magnet to Torbox
    const addRes = await axios.post(
      `${TORBOX_BASE}/createtorrent`,
      `magnet=${encodeURIComponent(magnetLink)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } }
    );

    if (!addRes.data?.success) {
      console.error("❌ Torbox Add Error:", addRes.data);
      return res.status(500).json({ error: "Failed to create torrent on Torbox" });
    }

    const torrentId = addRes.data.data.torrent_id;
    console.log(`📌 Torrent ID: ${torrentId}`);

    // Step B: Find Audio File ID
    let fileId = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      const listRes = await axios.get(`${TORBOX_BASE}/mylist?id=${torrentId}&bypass_cache=true`, { headers });
      const torrentInfo = Array.isArray(listRes.data?.data) ? listRes.data.data[0] : listRes.data?.data;
      const files = torrentInfo?.files || [];

      const targetFile = files
        .filter(f => /\.(flac|mp3|m4a|wav)$/i.test(f.name))
        .sort((a, b) => b.size - a.size)[0];

      if (targetFile) {
        fileId = targetFile.id;
        console.log(`✅ Selected File: ${targetFile.name}`);
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!fileId) return res.status(404).json({ error: "No audio files found in torrent" });

    // Step C: Get Direct CDN Stream URL
    const dlRes = await axios.get(
      `${TORBOX_BASE}/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrentId}&file_id=${fileId}&redirect=false`
    );

    if (dlRes.data?.success) {
      console.log("🚀 Link generated successfully!");
      res.json({
        url: dlRes.data.data,
        format: "flac",
        codec: "flac",
        container: "flac",
        manifest: "none"
      });
    } else {
      res.status(500).json({ error: "Could not fetch Torbox stream link" });
    }

  } catch (err) {
    console.error("❌ Stream Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
