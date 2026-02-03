const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs').promises;
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TRAKT_CLIENT_ID = '9cf5e07c0fa71537ded08bd2c9a672f2d8ab209be584db531c0d82535027bb13';
const TRAKT_CLIENT_SECRET = 'f91521782bf59a7a5c78634821254673b16a62f599ba9f8aa17ba3040a47114c';
const BASE_URL = process.env.BASE_URL || 'http://localhost:10000';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

// CACHE IN MEMORY
const catalogCache = new Map();
const CACHE_DURATION = 3600000; // 1 ora

console.log('\nTrakt Ultimate v10.0 LAZY LOADING - Starting...\n');
console.log(`Base URL: ${BASE_URL}`);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

http.globalAgent.maxSockets = 200;
https.globalAgent.maxSockets = 200;

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 1000
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({ 
    status: 'ok', 
    version: '10.0.0',
    memory: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    mode: 'Lazy Loading + Cache',
    cached_catalogs: catalogCache.size
  });
});

// TRADUZIONE AUTOMATICA (solo quando necessario)
async function translateToItalian(text) {
  if (!text || text.length < 3) return text;
  
  try {
    const response = await axios.get('https://api.mymemory.translated.net/get', {
      params: {
        q: text.substring(0, 500),
        langpair: 'en|it'
      },
      timeout: 1000
    });
    
    if (response.data?.responseData?.translatedText) {
      return response.data.responseData.translatedText;
    }
    return text;
  } catch {
    return text;
  }
}

function buildPosterUrl(imdbId, config) {
  if (config.posterType === 'rpdb' && config.rpdbApiKey && imdbId) {
    return `https://api.ratingposterdb.com/${config.rpdbApiKey}/imdb/poster-default/${imdbId}.jpg`;
  }
  if (imdbId) {
    return `https://images.metahub.space/poster/small/${imdbId}/img`;
  }
  return 'https://via.placeholder.com/500x750/667eea/ffffff?text=Trakt';
}

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
    if (seen.has(meta.trakt_id)) return false;
    seen.add(meta.trakt_id);
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
    
    res.send(`<!DOCTYPE html><html><head><title>Reset</title><style>body{font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}.container{text-align:center;background:rgba(255,255,255,.1);padding:40px;border-radius:20px}.btn{display:inline-block;padding:15px 30px;background:#fff;color:#667eea;text-decoration:none;border-radius:30px;font-weight:bold;margin:10px}</style></head><body><div class="container"><h1>Reset!</h1><p><strong>${req.params.username}</strong></p><a href="/auth/trakt" class="btn">Login</a><a href="/configure" class="btn">Settings</a></div></body></html>`);
  } catch {
    res.status(500).json({ error: 'Error' });
  }
});

app.get('/:config/manifest.json', async (req, res) => {
  try {
    const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
    const dbConfig = await getUserConfig(JSON.parse(configStr).username);
    if (!dbConfig) return res.status(404).json({ error: 'User not found' });
    
    const catalogs = (dbConfig.custom_lists || []).map(list => ({
      id: `trakt-${list.id}`,
      name: list.customName || list.name,
      type: 'traktultimate',
      // EXTRA IMPORTANTE per paginazione
      extra: [{ name: 'skip', isRequired: false }]
    }));
    
    if (catalogs.length === 0) {
      catalogs.push({ id: 'trakt-empty', name: 'Add lists', type: 'traktultimate' });
    }
    
    res.json({
      id: 'org.trakttv.ultimate',
      version: '10.0.0',
      name: 'Trakt Ultimate',
      description: 'Instant • Lazy Loading',
      resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['trakt:'] }],
      types: ['traktultimate'],
      catalogs: catalogs,
      idPrefixes: ['trakt'],
      background: `${BASE_URL}/IMG_1400.jpeg`,
      logo: `${BASE_URL}/IMG_1400.jpeg`,
      behaviorHints: { adult: false, p2p: false, configurable: true }
    });
  } catch {
    res.status(500).json({ error: 'Invalid config' });
  }
});

// FUNZIONE PER FETCH ALL CON LOOP
async function fetchAllItems(baseEndpoint, config, requireAuth) {
  let items = [];
  let page = 1;
  const limit = 100; // Max per Trakt
  while (true) {
    let endpoint = `${baseEndpoint}${baseEndpoint.includes('?') ? '&' : '?'}extended=full&page=${page}&limit=${limit}`;
    const response = await callTraktAPI(endpoint, config, 'GET', null, requireAuth);
    items.push(...response.data);
    if (response.data.length < limit) break;
    page++;
  }
  return items;
}

// LAZY LOADING CATALOG - CARICA SOLO 30 ITEMS ALLA VOLTA
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
  try {
    const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
    const dbConfig = await getUserConfig(JSON.parse(configStr).username);
    if (!dbConfig) return res.status(404).json({ error: 'User not found' });
    
    const config = {
      username: dbConfig.username,
      traktToken: dbConfig.trakt_token,
      refreshToken: dbConfig.refresh_token,
      rpdbApiKey: dbConfig.rpdb_api_key,
      posterType: dbConfig.poster_type,
      customLists: dbConfig.custom_lists || [],
      sortBy: dbConfig.sort_by
    };
    
    const catalogId = req.params.id;
    if (catalogId === 'trakt-empty') return res.json({ metas: [] });
    
    const list = config.customLists.find(l => l.id === catalogId.replace(/^trakt-/, ''));
    if (!list) return res.json({ metas: [] });
    
    // PARSING SKIP PARAMETER
    let skip = 0;
    if (req.params.extra) {
      const extraParams = req.params.extra.split('&').reduce((acc, param) => {
        const [key, value] = param.split('=');
        acc[key] = value;
        return acc;
      }, {});
      skip = parseInt(extraParams.skip || '0');
    }
    
    const ITEMS_PER_PAGE = 30;
    
    const cacheKey = `${catalogId}-${config.username}`;
    const now = Date.now();
    
    let baseEndpoint = `/users/${list.username}/lists/${list.slug}/items`;
    let requireAuth = false;
    
    if (list.id.includes('recommended')) {
      baseEndpoint = list.name.toLowerCase().includes('movie') 
        ? '/recommendations/movies?limit=100' 
        : '/recommendations/shows?limit=100';
      requireAuth = true;
    }
    
    // Se sortBy è default, usa vero lazy loading con paginazione Trakt
    if (config.sortBy === 'default') {
      console.log(`LAZY MODE: ${list.customName || list.name} - Fetching page for skip ${skip}`);
      
      const TRAKT_LIMIT = 100;
      const globalSkip = skip;
      const startPage = Math.floor(globalSkip / TRAKT_LIMIT) + 1;
      const endOffset = globalSkip + ITEMS_PER_PAGE;
      const endPage = Math.floor((endOffset - 1) / TRAKT_LIMIT) + 1;
      
      let allFetched = [];
      
      for (let p = startPage; p <= endPage; p++) {
        const pageCacheKey = `${cacheKey}-page${p}`;
        
        let pageData;
        if (catalogCache.has(pageCacheKey)) {
          const cached = catalogCache.get(pageCacheKey);
          if (now - cached.timestamp < CACHE_DURATION) {
            pageData = cached.data;
            console.log(`PAGE CACHE HIT: page ${p}`);
          }
        }
        
        if (!pageData) {
          console.log(`PAGE CACHE MISS: Fetching page ${p}`);
          let pagedEndpoint = `${baseEndpoint}${baseEndpoint.includes('?') ? '&' : '?'}extended=full&page=${p}&limit=${TRAKT_LIMIT}`;
          const response = await callTraktAPI(pagedEndpoint, config, 'GET', null, requireAuth);
          pageData = response.data;
          catalogCache.set(pageCacheKey, { data: pageData, timestamp: now });
        }
        
        allFetched.push(...pageData);
      }
      
      const localSkip = globalSkip % TRAKT_LIMIT;
      const paginatedItems = allFetched.slice(localSkip, localSkip + ITEMS_PER_PAGE);
      
      if (paginatedItems.length === 0) return res.json({ metas: [] });
      
      const metas = paginatedItems.map(item => {
        const content = item.show || item.movie || item;
        const type = item.show ? 'series' : 'movie';
        
        const traktId = content.ids?.trakt;
        const imdbId = content.ids?.imdb;
        
        if (!traktId) return null;
        
        return {
          id: `trakt:${type}:${traktId}`,
          type: type,
          name: content.title || 'Unknown',
          poster: buildPosterUrl(imdbId, config),
          description: content.overview || 'Nessuna trama disponibile',
          releaseInfo: content.year?.toString() || '',
          imdbRating: content.rating ? (content.rating / 10).toFixed(1) : undefined,
          genres: content.genres || [],
          trakt_id: traktId,
          imdb_id: imdbId
        };
      }).filter(Boolean);
      
      return res.json({ metas });
    } else {
      // Modalità full fetch con cache per sort custom
      if (catalogCache.has(cacheKey)) {
        const cached = catalogCache.get(cacheKey);
        if (now - cached.timestamp < CACHE_DURATION) {
          console.log(`FULL CACHE HIT: ${list.customName || list.name} - Serving ${skip}-${skip + ITEMS_PER_PAGE}`);
          const paginatedMetas = cached.metas.slice(skip, skip + ITEMS_PER_PAGE);
          return res.json({ metas: paginatedMetas });
        }
      }
      
      // CACHE MISS - Fetch all
      console.log(`FULL CACHE MISS: ${list.customName || list.name} - Building full cache...`);
      const startTime = Date.now();
      
      const items = await fetchAllItems(baseEndpoint, config, requireAuth);
      if (items.length === 0) {
        catalogCache.set(cacheKey, { metas: [], timestamp: now });
        return res.json({ metas: [] });
      }
      
      const allMetas = items.map(item => {
        const content = item.show || item.movie || item;
        const type = item.show ? 'series' : 'movie';
        
        const traktId = content.ids?.trakt;
        const imdbId = content.ids?.imdb;
        
        if (!traktId) return null;
        
        return {
          id: `trakt:${type}:${traktId}`,
          type: type,
          name: content.title || 'Unknown',
          poster: buildPosterUrl(imdbId, config),
          description: content.overview || 'Nessuna trama disponibile',
          releaseInfo: content.year?.toString() || '',
          imdbRating: content.rating ? (content.rating / 10).toFixed(1) : undefined,
          genres: content.genres || [],
          trakt_id: traktId,
          imdb_id: imdbId
        };
      }).filter(Boolean);
      
      const deduped = deduplicateMetas(allMetas);
      const sorted = sortMetas(deduped, config.sortBy);
      
      catalogCache.set(cacheKey, { metas: sorted, timestamp: now });
      
      console.log(`Cache built in ${(Date.now() - startTime)/1000}s - Total items: ${sorted.length}`);
      
      const paginatedMetas = sorted.slice(skip, skip + ITEMS_PER_PAGE);
      return res.json({ metas: paginatedMetas });
    }
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ metas: [] });
  }
});

// AGGIUNGI QUI ALTRI ENDPOINT SE PRESENTI NEL CODICE ORIGINALE (ES. META DETAILS, AUTH ECC.)
// Ad esempio, se c'è un endpoint per meta, aggiungilo qui.

// START SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});