const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TRAKT_CLIENT_ID = '9cf5e07c0fa71537ded08bd2c9a672f2d8ab209be584db531c0d82535027bb13';
const TRAKT_CLIENT_SECRET = 'f91521782bf59a7a5c78634821254673b16a62f599ba9f8aa17ba3040a47114c';
const BASE_URL = process.env.BASE_URL || 'http://localhost:10000';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

// ⚡ CACHE IN MEMORY - Durata 1 ora
const catalogCache = new Map();
const CACHE_DURATION = 3600000;

console.log('\n🐱💜 Trakt Ultimate v11.0 AIOMETA COMPATIBLE - Starting...\n');
console.log(`📍 Base URL: ${BASE_URL}`);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

http.globalAgent.maxSockets = 200;
https.globalAgent.maxSockets = 200;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({ 
    status: 'ok', 
    version: '11.0.0',
    memory: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    mode: 'AIOMetadata Compatible',
    cached_catalogs: catalogCache.size
  });
});

async function getUserConfig(username) {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('username', username).single();
    if (error && error.code !== 'PGRST116') return null;
    return data;
  } catch (err) {
    return null;
  }
}

async function saveUserConfig(config) {
  try {
    const listsToSave = Array.isArray(config.customLists) ? config.customLists : [];
    
    const { error } = await supabase.from('users').upsert({
      username: config.username,
      trakt_token: config.traktToken,
      refresh_token: config.refreshToken,
      tmdb_api_key: config.tmdbApiKey || '',
      rpdb_api_key: config.rpdbApiKey || '',
      poster_type: config.posterType || 'tmdb',
      custom_lists: listsToSave,
      sort_by: config.sortBy || 'default',
      updated_at: new Date().toISOString()
    }, { onConflict: 'username' });
    
    return !error;
  } catch (err) {
    return false;
  }
}

async function refreshAccessToken(refreshToken) {
  try {
    const response = await axios.post('https://api.trakt.tv/oauth/token', {
      refresh_token: refreshToken,
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'refresh_token'
    }, { timeout: 10000 });
    return response.data;
  } catch (error) {
    return null;
  }
}

async function callTraktAPI(endpoint, config, method = 'GET', data = null, requireAuth = false) {
  const makeRequest = async (token) => {
    const headers = {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': TRAKT_CLIENT_ID
    };
    
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    return await axios({
      method,
      url: `https://api.trakt.tv${endpoint}`,
      headers,
      ...(data && { data }),
      timeout: 10000
    });
  };

  try {
    return await makeRequest(config.traktToken);
  } catch (error) {
    if (error.response?.status === 401 && config.refreshToken) {
      const newTokens = await refreshAccessToken(config.refreshToken);
      if (newTokens) {
        config.traktToken = newTokens.access_token;
        config.refreshToken = newTokens.refresh_token;
        await saveUserConfig(config);
        return await makeRequest(newTokens.access_token);
      }
    }
    if (error.response?.status === 401 && !requireAuth) {
      return await makeRequest(null);
    }
    throw error;
  }
}

function deduplicateMetas(metas) {
  const seen = new Set();
  return metas.filter(meta => {
    if (seen.has(meta.id)) return false;
    seen.add(meta.id);
    return true;
  });
}

function sortMetas(metas, sortBy) {
  if (sortBy === 'rating') {
    return metas.sort((a, b) => (parseFloat(b.imdbRating) || 0) - (parseFloat(a.imdbRating) || 0));
  } else if (sortBy === 'year') {
    return metas.sort((a, b) => parseInt(b.releaseInfo || '0') - parseInt(a.releaseInfo || '0'));
  } else if (sortBy === 'name') {
    return metas.sort((a, b) => a.name.localeCompare(b.name));
  }
  return metas;
}

app.get('/reset-auth/:username', async (req, res) => {
  try {
    const user = await getUserConfig(req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    await supabase.from('users').update({ 
      trakt_token: '', refresh_token: '', updated_at: new Date().toISOString()
    }).eq('username', req.params.username);
    
    res.send(`<!DOCTYPE html><html><head><title>Reset</title><style>body{font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}.container{text-align:center;background:rgba(255,255,255,.1);padding:40px;border-radius:20px}.btn{display:inline-block;padding:15px 30px;background:#fff;color:#667eea;text-decoration:none;border-radius:30px;font-weight:bold;margin:10px}</style></head><body><div class="container"><h1>✅ Reset!</h1><p><strong>${req.params.username}</strong></p><a href="/auth/trakt" class="btn">🔐 Login</a><a href="/configure" class="btn">⚙️ Settings</a></div></body></html>`);
  } catch {
    res.status(500).json({ error: 'Error' });
  }
});

// ⚡ MANIFEST - SOLO CATALOG (no meta, lo fa AIOMetadata!)
app.get('/:config/manifest.json', async (req, res) => {
  try {
    const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
    const dbConfig = await getUserConfig(JSON.parse(configStr).username);
    if (!dbConfig) return res.status(404).json({ error: 'User not found' });
    
    const catalogs = (dbConfig.custom_lists || []).map(list => ({
      id: `trakt-${list.id}`,
      name: list.customName || list.name,
      type: list.name.toLowerCase().includes('movie') ? 'movie' : 'series'
    }));
    
    if (catalogs.length === 0) {
      catalogs.push({ id: 'trakt-empty', name: '⚠️ Add lists', type: 'movie' });
    }
    
    res.json({
      id: 'org.trakttv.ultimate',
      version: '11.0.0',
      name: 'Trakt Ultimate',
      description: 'AIOMetadata Compatible • Ultra Fast • Cached',
      // ⚡ SOLO CATALOG - AIOMetadata gestisce i meta!
      resources: ['catalog'],
      types: ['movie', 'series'],
      catalogs: catalogs,
      background: `${BASE_URL}/IMG_1400.jpeg`,
      logo: `${BASE_URL}/IMG_1400.jpeg`,
      behaviorHints: { adult: false, p2p: false, configurable: true }
    });
  } catch {
    res.status(500).json({ error: 'Invalid config' });
  }
});

// ⚡⚡⚡ CATALOG ULTRA VELOCE - Solo ID IMDb (AIOMetadata fa il resto!)
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
  try {
    const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
    const dbConfig = await getUserConfig(JSON.parse(configStr).username);
    if (!dbConfig) return res.status(404).json({ error: 'User not found' });
    
    const config = {
      username: dbConfig.username,
      traktToken: dbConfig.trakt_token,
      refreshToken: dbConfig.refresh_token,
      customLists: dbConfig.custom_lists || [],
      sortBy: dbConfig.sort_by
    };
    
    const catalogId = req.params.id;
    if (catalogId === 'trakt-empty') return res.json({ metas: [] });
    
    const list = config.customLists.find(l => l.id === catalogId.replace(/^trakt-/, ''));
    if (!list) return res.json({ metas: [] });
    
    const cacheKey = `${catalogId}-${config.username}`;
    const now = Date.now();
    
    // ⚡ CHECK CACHE
    if (catalogCache.has(cacheKey)) {
      const cached = catalogCache.get(cacheKey);
      if (now - cached.timestamp < CACHE_DURATION) {
        console.log(`⚡ CACHE HIT: ${list.customName || list.name} (${cached.metas.length} items) - INSTANT!`);
        return res.json({ metas: cached.metas });
      }
    }
    
    // ⚡ CACHE MISS - Build cache VELOCISSIMO
    console.log(`📦 Building cache: ${list.customName || list.name}`);
    const startTime = Date.now();
    
    let endpoint = `/users/${list.username}/lists/${list.slug}/items`;
    let requireAuth = false;
    
    if (list.id.includes('recommended')) {
      endpoint = list.name.toLowerCase().includes('movie') 
        ? '/recommendations/movies?limit=100' 
        : '/recommendations/shows?limit=100';
      requireAuth = true;
    }
    
    const response = await callTraktAPI(endpoint, config, 'GET', null, requireAuth);
    if (!response.data || response.data.length === 0) {
      catalogCache.set(cacheKey, { metas: [], timestamp: now });
      return res.json({ metas: [] });
    }
    
    const totalItems = response.data.length;
    console.log(`  Processing ${totalItems} items for AIOMetadata...`);
    
    // ⚡ VELOCISSIMO - Solo ID e dati base (AIOMetadata fa tutto il resto!)
    const allMetas = response.data
      .map(item => {
        const content = item.show || item.movie || item;
        const type = item.show ? 'series' : 'movie';
        const imdbId = content.ids?.imdb;
        
        // ⚡ IMPORTANTE: serve IMDb ID per AIOMetadata!
        if (!imdbId) return null;
        
        return {
          id: imdbId, // ⚡ ID IMDb standard - AIOMetadata lo intercetta!
          type: type,
          name: content.title || 'Unknown',
          releaseInfo: content.year?.toString() || '',
          // ⚡ AIOMetadata aggiungerà: poster, description, background, genres, rating, etc.
        };
      })
      .filter(Boolean);
    
    const sortedMetas = sortMetas(deduplicateMetas(allMetas), config.sortBy);
    
    // ⚡ SALVA IN CACHE (1 ora)
    catalogCache.set(cacheKey, {
      metas: sortedMetas,
      timestamp: now
    });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Cached ${sortedMetas.length} items in ${elapsed}s (AIOMetadata will enrich)`);
    
    res.json({ metas: sortedMetas });
    
  } catch (error) {
    console.error('❌', error.message);
    res.json({ metas: [] });
  }
});

app.get('/auth/trakt', (req, res) => {
  const state = Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64');
  res.redirect(`https://trakt.tv/oauth/authorize?client_id=${TRAKT_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=${state}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/configure?error=${error}`);
  if (!code) return res.redirect(`/configure?error=missing_code`);
  
  try {
    const tokenResp = await axios.post('https://api.trakt.tv/oauth/token', {
      code, client_id: TRAKT_CLIENT_ID, client_secret: TRAKT_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
    });
    
    const userResp = await axios.get('https://api.trakt.tv/users/me', {
      headers: { 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID, 'Authorization': `Bearer ${tokenResp.data.access_token}` }
    });
    
    const username = userResp.data.username;
    const existing = await getUserConfig(username);
    
    await saveUserConfig({
      username,
      traktToken: tokenResp.data.access_token,
      refreshToken: tokenResp.data.refresh_token,
      tmdbApiKey: existing?.tmdb_api_key || '',
      rpdbApiKey: existing?.rpdb_api_key || '',
      posterType: existing?.poster_type || 'tmdb',
      customLists: existing?.custom_lists || [],
      sortBy: existing?.sort_by || 'default'
    });
    
    res.redirect(`/configure?success=1&username=${username}`);
  } catch {
    res.redirect('/configure?error=auth_failed');
  }
});

app.get('/api/load-config', async (req, res) => {
  const config = await getUserConfig(req.query.username);
  config ? res.json(config) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/save-config', async (req, res) => {
  const saved = await saveUserConfig(req.body);
  saved ? res.json({ success: true }) : res.status(500).json({ error: 'Failed' });
});

app.get('/api/clear-cache', (req, res) => {
  catalogCache.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

app.listen(PORT, () => {
  console.log(`✅ Server ready at ${BASE_URL}`);
  console.log(`💾 CACHE: 1 hour in-memory`);
  console.log(`⚡ SPEED: Ultra fast (no TMDB calls)`);
  console.log(`🎨 AIOMetadata will add: IT posters, descriptions, backgrounds`);
  console.log(`📝 Install AIOMetadata AFTER this addon in Stremio!`);
  console.log(`🚀 v11.0 AIOMETA COMPATIBLE\n`);
});
