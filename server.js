require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const TORBOX_BASE = 'https://api.torbox.app/v1/api/torrents';

// 1. MANIFEST ENDPOINT - Explains your addon to Eclipse
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

// 2. SEARCH ENDPOINT - Triggered when you search inside Eclipse
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ tracks: [] });

  try {
    const searchUrl = `https://apibay.org/q.php?q=${encodeURIComponent(query + ' flac')}`;
    const apiRes = await axios.get(searchUrl, { timeout: 8000 });
    const results = apiRes.data;

    if (!results || results[0]?.id === '0') {
      return res.json({ tracks: [] });
    }

    const tracks = results.slice(0, 10).map((item) => {
      const magnet = `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}`;
      
      return {
        id: Buffer.from(magnet).toString('base64'),
        title: item.name,
        artist: "Torrent Source",
        album: "FLAC Collection",
        format: "flac"
      };
    });

    res.json({ tracks });
  } catch (err) {
    console.error("Search Error:", err.message);
    res.json({ tracks: [] });
  }
});

// 3. STREAM ENDPOINT - Triggered when you hit Play in Eclipse
app.get('/stream/:id', async (req, res) => {
  try {
    const magnetLink = Buffer.from(req.params.id, 'base64').toString('utf-8');
    console.log(`\n▶️ Received stream request for magnet: ${magnetLink.slice(0, 60)}...`);

    const headers = { Authorization: `Bearer ${TORBOX_API_KEY}` };

    // Step A: Register Magnet on Torbox
    const addRes = await axios.post(
      `${TORBOX_BASE}/createtorrent`,
      `magnet=${encodeURIComponent(magnetLink)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } }
    );

    if (!addRes.data?.success) {
      console.error("Torbox Add Error:", addRes.data);
      return res.status(500).json({ error: "Failed to create torrent on Torbox" });
    }

    const torrentId = addRes.data.data.torrent_id;

    // Step B: Poll Torbox until file list populates
    let fileId = null;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const listRes = await axios.get(`${TORBOX_BASE}/mylist?id=${torrentId}&bypass_cache=true`, { headers });
      const torrentInfo = Array.isArray(listRes.data?.data) ? listRes.data.data[0] : listRes.data?.data;
      const files = torrentInfo?.files || [];

      const flacFile = files
        .filter(f => f.name.toLowerCase().endsWith('.flac'))
        .sort((a, b) => b.size - a.size)[0];

      if (flacFile) {
        fileId = flacFile.id;
        console.log(`✅ Found FLAC track: ${flacFile.name}`);
        break;
      }
      
      console.log(`⏳ Waiting for metadata... (${attempt}/20)`);
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!fileId) {
      return res.status(404).json({ error: "No FLAC file found in torrent" });
    }

    // Step C: Request direct stream link from Torbox
    const dlRes = await axios.get(
      `${TORBOX_BASE}/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrentId}&file_id=${fileId}&redirect=false`
    );

    if (dlRes.data?.success) {
      res.json({
        url: dlRes.data.data,
        format: "flac",
        codec: "flac",
        container: "flac",
        manifest: "none",
        sampleRate: 44100,
        bitDepth: 16
      });
    } else {
      res.status(500).json({ error: "Could not request stream URL from Torbox" });
    }

  } catch (err) {
    console.error("Stream Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Eclipse Addon running on http://localhost:${PORT}`);
  console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
});