require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

const app = express();
app.use(express.json());

// Enable CORS for Eclipse / Stremio
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const PORT = process.env.PORT || 10000;
const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const JACKETT_URL = process.env.JACKETT_URL ? process.env.JACKETT_URL.replace(/\/$/, '') : '';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY;

const TORBOX_BASE = 'https://api.torbox.app/v1/api/torrents';
const xmlParser = new xml2js.Parser({ explicitArray: false });

// 1. MANIFEST ENDPOINT
app.get('/manifest.json', (req, res) => {
  res.json({
    id: "com.user.torbox.flac",
    name: "Torbox FLAC Engine",
    version: "1.0.0",
    description: "Streams high-fidelity FLAC audio from torrents via Jackett & Torbox",
    resources: ["search", "stream"],
    types: ["track"],
    contentType: "music"
  });
});

// 2. SEARCH ENDPOINT (Queries Jackett Torznab Feed)
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ tracks: [] });

  console.log(`\n🔎 Querying Jackett for: "${query}"`);

  try {
    // Torznab API call to search all configured indexers (Category 3000 = Audio)
    const searchUrl = `${JACKETT_URL}/api/v2.0/indexers/all/results/torznab/api?apikey=${JACKETT_API_KEY}&t=search&cat=3000&q=${encodeURIComponent(query)}`;
    
    const response = await axios.get(searchUrl, { timeout: 10000 });
    const parsedXml = await xmlParser.parseStringPromise(response.data);

    const items = parsedXml?.rss?.channel?.item;
    let resultsList = [];

    if (Array.isArray(items)) {
      resultsList = items;
    } else if (items) {
      resultsList = [items];
    }

    const tracks = resultsList.map(item => {
      // Find magnet link in torznab attributes or enclosure
      let magnet = null;
      if (item.link && item.link.startsWith('magnet:')) {
        magnet = item.link;
      } else if (item['torznab:attr']) {
        const attrs = Array.isArray(item['torznab:attr']) ? item['torznab:attr'] : [item['torznab:attr']];
        const magnetAttr = attrs.find(a => a.$.name === 'magneturl');
        if (magnetAttr) magnet = magnetAttr.$.value;
      }

      if (!magnet && item.enclosure && item.enclosure.$.url && item.enclosure.$.url.startsWith('magnet:')) {
        magnet = item.enclosure.$.url;
      }

      if (!magnet) return null;

      return {
        id: Buffer.from(magnet).toString('base64'),
        title: item.title,
        artist: "Jackett Release",
        album: item.category || "Audio",
        format: item.title.toLowerCase().includes('flac') ? 'flac' : 'mp3'
      };
    }).filter(Boolean);

    console.log(`✅ Found ${tracks.length} track(s) from Jackett`);
    res.json({ tracks });

  } catch (err) {
    console.error("❌ Jackett Search Error:", err.message);
    res.json({ tracks: [] });
  }
});

// 3. STREAM ENDPOINT (Torbox CDN Link)
app.get('/stream/:id', async (req, res) => {
  try {
    const magnetLink = Buffer.from(req.params.id, 'base64').toString('utf-8');
    console.log(`\n▶️ Received stream request...`);

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

    // Step C: Request Direct CDN Stream Link
    const dlRes = await axios.get(
      `${TORBOX_BASE}/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrentId}&file_id=${fileId}&redirect=false`
    );

    if (dlRes.data?.success) {
      console.log("🚀 CDN Stream Link generated!");
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
