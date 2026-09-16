require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

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

// 2. SEARCH ENDPOINT - Powered directly by Torbox Search API
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    console.log("⚠️ Received empty search query");
    return res.json({ tracks: [] });
  }

  console.log(`\n🔎 Searching Torbox indexer for: "${query}"`);

  try {
    // Search Torbox internal indexer for FLAC tracks
    const torboxSearchUrl = `${TORBOX_BASE}/search?query=${encodeURIComponent(query + ' flac')}`;
    const searchRes = await axios.get(torboxSearchUrl, {
      headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
      timeout: 10000
    });

    let results = searchRes.data?.data || [];

    // Fallback search without 'flac' keyword if empty
    if (results.length === 0) {
      console.log(`ℹ️ No direct FLAC hits. Trying general search for "${query}"...`);
      const fallbackUrl = `${TORBOX_BASE}/search?query=${encodeURIComponent(query)}`;
      const fallbackRes = await axios.get(fallbackUrl, {
        headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
        timeout: 10000
      });
      results = fallbackRes.data?.data || [];
    }

    if (!Array.isArray(results) || results.length === 0) {
      console.log(`❌ No torrent results returned for "${query}"`);
      return res.json({ tracks: [] });
    }

    // Map Torbox search items into Eclipse track objects
    const tracks = results.slice(0, 10).map((item) => {
      const magnet = item.magnet || item.hash ? `magnet:?xt=urn:btih:${item.hash}` : null;
      if (!magnet) return null;

      return {
        id: Buffer.from(magnet).toString('base64'),
        title: item.name || item.title || query,
        artist: "Torrent Source",
        album: "FLAC Collection",
        format: "flac"
      };
    }).filter(Boolean);

    console.log(`✅ Returning ${tracks.length} tracks to Eclipse`);
    res.json({ tracks });

  } catch (err) {
    console.error("❌ Search Exception:", err.response?.data || err.message);
    res.json({ tracks: [] });
  }
});

// 3. STREAM ENDPOINT - Fetch direct stream link via Torbox CDN
app.get('/stream/:id', async (req, res) => {
  try {
    const magnetLink = Buffer.from(req.params.id, 'base64').toString('utf-8');
    console.log(`\n▶️ Stream requested for magnet: ${magnetLink.slice(0, 50)}...`);

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
    console.log(`📌 Torrent registered on Torbox. ID: ${torrentId}`);

    // Step B: Poll Torbox for audio file ID
    let fileId = null;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const listRes = await axios.get(`${TORBOX_BASE}/mylist?id=${torrentId}&bypass_cache=true`, { headers });
      const torrentInfo = Array.isArray(listRes.data?.data) ? listRes.data.data[0] : listRes.data?.data;
      const files = torrentInfo?.files || [];

      const targetFile = files
        .filter(f => /\.(flac|mp3|m4a|wav)$/i.test(f.name))
        .sort((a, b) => b.size - a.size)[0];

      if (targetFile) {
        fileId = targetFile.id;
        console.log(`✅ Selected file: ${targetFile.name}`);
        break;
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    if (!fileId) {
      return res.status(404).json({ error: "No valid audio files found in torrent" });
    }

    // Step C: Request CDN Link
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
        manifest: "none",
        sampleRate: 44100,
        bitDepth: 16
      });
    } else {
      res.status(500).json({ error: "Could not request stream link from Torbox" });
    }

  } catch (err) {
    console.error("❌ Stream Endpoint Exception:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
