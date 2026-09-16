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

// Common HTTP headers to mimic a browser request and avoid cloud provider blocks
const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

// 1. MANIFEST ENDPOINT - Registers the addon with Eclipse Music
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

// 2. SEARCH ENDPOINT - Handles queries from Eclipse Music
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    console.log("⚠️ Received empty search query");
    return res.json({ tracks: [] });
  }

  console.log(`\n🔎 Received search request for: "${query}"`);

  try {
    // Attempt 1: Search specifically for FLAC releases
    let searchUrl = `https://apibay.org/q.php?q=${encodeURIComponent(query + ' flac')}`;
    let apiRes = await axios.get(searchUrl, { timeout: 8000, headers: HTTP_HEADERS });
    let results = apiRes.data;

    // Attempt 2: Fallback to base query if no FLAC-specific torrents found
    if (!Array.isArray(results) || results.length === 0 || results[0]?.id === '0') {
      console.log(`ℹ️ No direct FLAC hits for "${query}". Trying fallback search...`);
      searchUrl = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
      apiRes = await axios.get(searchUrl, { timeout: 8000, headers: HTTP_HEADERS });
      results = apiRes.data;
    }

    // Return empty list if still no results
    if (!Array.isArray(results) || results.length === 0 || results[0]?.id === '0') {
      console.log(`❌ No torrent results found for "${query}"`);
      return res.json({ tracks: [] });
    }

    // Map the top 10 results for Eclipse
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

    console.log(`✅ Returning ${tracks.length} tracks to Eclipse`);
    res.json({ tracks });

  } catch (err) {
    console.error("❌ Search API Error:", err.message);
    res.json({ tracks: [] });
  }
});

// 3. STREAM ENDPOINT - Called when playback starts
app.get('/stream/:id', async (req, res) => {
  try {
    const magnetLink = Buffer.from(req.params.id, 'base64').toString('utf-8');
    console.log(`\n▶️ Stream requested for magnet: ${magnetLink.slice(0, 60)}...`);

    const headers = { Authorization: `Bearer ${TORBOX_API_KEY}` };

    // Step A: Submit magnet to Torbox
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
    console.log(`📌 Magnet registered on Torbox. Torrent ID: ${torrentId}`);

    // Step B: Poll Torbox to isolate the largest audio track
    let fileId = null;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const listRes = await axios.get(`${TORBOX_BASE}/mylist?id=${torrentId}&bypass_cache=true`, { headers });
      const torrentInfo = Array.isArray(listRes.data?.data) ? listRes.data.data[0] : listRes.data?.data;
      const files = torrentInfo?.files || [];

      // Prioritize .flac files, fallback to .mp3 / .m4a if unavailable
      const targetFile = files
        .filter(f => /\.(flac|mp3|m4a|wav)$/i.test(f.name))
        .sort((a, b) => b.size - a.size)[0];

      if (targetFile) {
        fileId = targetFile.id;
        console.log(`✅ Selected file for streaming: ${targetFile.name}`);
        break;
      }

      console.log(`⏳ Waiting for metadata parsing... (Attempt ${attempt}/20)`);
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!fileId) {
      console.error("❌ No valid audio files found in torrent payload");
      return res.status(404).json({ error: "No audio file found in torrent" });
    }

    // Step C: Request direct CDN download/stream link from Torbox
    const dlRes = await axios.get(
      `${TORBOX_BASE}/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrentId}&file_id=${fileId}&redirect=false`
    );

    if (dlRes.data?.success) {
      console.log("🚀 Stream link generated successfully. Sending to Eclipse.");
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
      console.error("❌ Torbox Download Request Error:", dlRes.data);
      res.status(500).json({ error: "Could not request stream URL from Torbox" });
    }

  } catch (err) {
    console.error("❌ Stream Endpoint Exception:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
});
