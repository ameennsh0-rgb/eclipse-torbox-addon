require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const TorrentSearchApi = require('torrent-search-api');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const TORBOX_BASE = 'https://api.torbox.app/v1/api/torrents';

// Enable public providers for torrent searching
TorrentSearchApi.enablePublicProviders();

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

// 2. SEARCH ENDPOINT - Multi-Provider Torrent Search
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    console.log("⚠️ Received empty search query");
    return res.json({ tracks: [] });
  }

  console.log(`\n🔎 Received search request for: "${query}"`);

  try {
    // Attempt 1: Search specifically for FLAC releases across public providers
    let torrents = await TorrentSearchApi.search(query + ' flac', 'Audio', 10);

    // Attempt 2: Fallback to general query if no explicit FLAC torrents are returned
    if (!torrents || torrents.length === 0) {
      console.log(`ℹ️ No direct FLAC hits for "${query}". Trying fallback search...`);
      torrents = await TorrentSearchApi.search(query, 'Audio', 10);
    }

    if (!torrents || torrents.length === 0) {
      console.log(`❌ No torrent results found for "${query}"`);
      return res.json({ tracks: [] });
    }

    // Resolve magnet links for top 10 results
    const trackPromises = torrents.slice(0, 10).map(async (torrent) => {
      try {
        const magnet = torrent.magnet || await TorrentSearchApi.getMagnet(torrent);
        if (!magnet) return null;

        return {
          id: Buffer.from(magnet).toString('base64'),
          title: torrent.title,
          artist: "Torrent Source",
          album: "FLAC Collection",
          format: "flac"
        };
      } catch (err) {
        return null;
      }
    });

    const resolvedTracks = await Promise.all(trackPromises);
    const validTracks = resolvedTracks.filter(track => track !== null);

    console.log(`✅ Returning ${validTracks.length} tracks to Eclipse`);
    res.json({ tracks: validTracks });

  } catch (err) {
    console.error("❌ Search Exception:", err.message);
    res.json({ tracks: [] });
  }
});

// 3. STREAM ENDPOINT - Called when playback starts
app.get('/stream/:id', async (req, res) => {
  try {
    const magnetLink = Buffer.from(req.params.id, 'base64').toString('utf-8');
    console.log(`\n▶️ Stream requested for magnet: ${magnetLink.slice(0, 60)}...`);

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
    console.log(`📌 Magnet registered on Torbox. Torrent ID: ${torrentId}`);

    // Step B: Poll Torbox to isolate the largest audio file
    let fileId = null;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const listRes = await axios.get(`${TORBOX_BASE}/mylist?id=${torrentId}&bypass_cache=true`, { headers });
      const torrentInfo = Array.isArray(listRes.data?.data) ? listRes.data.data[0] : listRes.data?.data;
      const files = torrentInfo?.files || [];

      // Prioritize .flac files, fallback to other audio formats if necessary
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

    // Step C: Get direct CDN link from Torbox
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
