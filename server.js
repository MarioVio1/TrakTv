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
const BATCH_SIZE = 50; // ⚡ Processa 50 alla volta

console.log('\n🐱💜 Trakt Ultimate v9.0 - BATCH LOADING - Starting...\n');
console.log(`📍 Base URL: ${BASE_URL}`);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

http.globalAgent.maxSockets = 200;
https.globalAgent.maxSockets = 200;

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 1500
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({ 
    status: 'ok', 
    version: '9.0.0',
    memory: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    mode: 'Batch loading - All items'
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

async function getTMDBItalian(tmdbId, type, apiKey) {
  try {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const response = await axios.get(
      `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${apiKey}&language=it-IT&append_to_response=external_ids`,
      { 
        timeout: 1500,
        httpsAgent,
        headers: { 'Accept-Encoding': 'gzip' }
      }
    );
    
    return {
      title: response.data.title || response.data.name,
      overview: response.data.overview,
      poster_path: response.data.poster_path,
      imdb_id: response.data.external_ids?.imdb_id
    };
  } catch {
    return null;
  }
}

function buildPosterUrl(imdbId, posterPath, config) {
  if (config.posterType === 'rpdb' && config.rpdbApiKey && imdbId) {
    return `https://api.ratingposterdb.com/${config.rpdbApiKey}/imdb/poster-default/${imdbId}.jpg`;
  }
  if (posterPath) {
    return `https://image.tmdb.org/t/p/w500${posterPath}`;
  }
  if (imdbId) {
    return `https://images.metahub.space/poster/small/${imdbId}/img`;
  }
  return 'https://via.placeholder.com/500x750/667eea/ffffff?text=Trakt';
}

// ⚡ PROCESSA BATCH di 50 items
async function processBatchItalian(items, config) {
  const promises = items.map(async (item) => {
    const content = item.show || item.movie || item;
    const type = item.show ? 'series' : 'movie';
    
    const traktId = content.ids?.trakt;
    const tmdbId = content.ids?.tmdb;
    let imdbId = content.ids?.imdb;
    
    if (!traktId) return null;
    
    let italianTitle = content.title;
    let italianOverview = content.overview || '';
    let posterPath = null;
    
    if (tmdbId) {
      const tmdbData = await getTMDBItalian(tmdbId, type, config.tmdbApiKey);
      if (tmdbData) {
        italianTitle = tmdbData.title || content.title;
        italianOverview = tmdbData.overview || content.overview || '';
        posterPath = tmdbData.poster_path;
        if (tmdbData.imdb_id) imdbId = tmdbData.imdb_id;
      }
    }
    
    return {
      id: `trakt:${type}:${traktId}`,
      type: type,
      name: italianTitle,
      poster: buildPosterUrl(imdbId, posterPath, config),
      description: italianOverview,
      releaseInfo: content.year?.toString() || '',
      imdbRating: content.rating ? (content.rating / 10).toFixed(1) : undefined,
      genres: content.genres || [],
      imdb_id: imdbId,
      trakt_id: traktId,
      tmdb_id: tmdbId
    };
  });
  
  const results = await Promise.allSettled(promises);
  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
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
    
    res.send(`<!DOCTYPE html><html><head><title>Reset</title><style>body{font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}.container{text-align:center;background:rgba(255,255,255,.1);padding:40px;border-radius:20px}.btn{display:inline-block;padding:15px 30px;background:#fff;color:#667eea;text-decoration:none;border-radius:30px;font-weight:bold;margin:10px}</style></head><body><div class="container"><h1>✅ Reset!</h1><p><strong>${req.params.username}</strong></p><a href="/auth/trakt" class="btn">🔐 Login</a><a href="/configure" class="btn">⚙️ Settings</a></div></body></html>`);
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
      type: 'traktultimate'
    }));
    
    if (catalogs.length === 0) {
      catalogs.push({ id: 'trakt-empty', name: '⚠️ Add lists', type: 'traktultimate' });
    }
    
    res.json({
      id: 'org.trakttv.ultimate',
      version: '9.0.0',
      name: 'Trakt Ultimate',
      description: 'Italian • All items • Batch loading',
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

// ⚡ CATALOG - CARICA TUTTO A BATCH DI 50
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
  try {
    const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
    const dbConfig = await getUserConfig(JSON.parse(configStr).username);
    if (!dbConfig) return res.status(404).json({ error: 'User not found' });
    
    const config = {
      username: dbConfig.username,
      traktToken: dbConfig.trakt_token,
      refreshToken: dbConfig.refresh_token,
      tmdbApiKey: dbConfig.tmdb_api_key || '9f6dbcbddf9565f6a0f004fca81f83ee',
      rpdbApiKey: dbConfig.rpdb_api_key,
      posterType: dbConfig.poster_type,
      customLists: dbConfig.custom_lists || [],
      sortBy: dbConfig.sort_by
    };
    
    const catalogId = req.params.id;
    if (catalogId === 'trakt-empty') return res.json({ metas: [] });
    
    const list = config.customLists.find(l => l.id === catalogId.replace(/^trakt-/, ''));
    if (!list) return res.json({ metas: [] });
    
    const startTime = Date.now();
    console.log(`⚡ ${list.customName || list.name}`);
    
    let endpoint = `/users/${list.username}/lists/${list.slug}/items`;
    let requireAuth = false;
    
    if (list.id.includes('recommended')) {
      endpoint = list.name.toLowerCase().includes('movie') 
        ? '/recommendations/movies?limit=100' 
        : '/recommendations/shows?limit=100';
      requireAuth = true;
    }
    
    const response = await callTraktAPI(endpoint, config, 'GET', null, requireAuth);
    if (!response.data || response.data.length === 0) return res.json({ metas: [] });
    
    const totalItems = response.data.length;
    console.log(`  📦 Total: ${totalItems} items - processing in batches of ${BATCH_SIZE}...`);
    
    // ⚡ PROCESSA TUTTI GLI ITEMS A BATCH DI 50
    let allMetas = [];
    let processed = 0;
    
    for (let i = 0; i < response.data.length; i += BATCH_SIZE) {
      const batch = response.data.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(totalItems / BATCH_SIZE);
      
      console.log(`  ⚡ Batch ${batchNumber}/${totalBatches} (${batch.length} items)...`);
      
      const batchMetas = await processBatchItalian(batch, config);
      allMetas.push(...batchMetas);
      processed += batch.length;
      
      // Piccola pausa tra batch per non sovraccaricare
      if (i + BATCH_SIZE < response.data.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    allMetas = deduplicateMetas(allMetas);
    allMetas = sortMetas(allMetas, config.sortBy);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ ${allMetas.length} items loaded in ${elapsed}s (avg: ${(elapsed / Math.ceil(totalItems / BATCH_SIZE)).toFixed(1)}s per batch)`);
    
    res.json({ metas: allMetas });
    
  } catch (error) {
    console.error('❌', error.message);
    res.json({ metas: [] });
  }
});

app.get('/:config/meta/:type/:id.json', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id.startsWith('trakt:')) {
      return res.json({ meta: { id, type: req.params.type, name: 'Contenuto' } });
    }
    
    const [, originalType, traktId] = id.split(':');
    const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
    const dbConfig = await getUserConfig(JSON.parse(configStr).username);
    
    const config = {
      traktToken: dbConfig?.trakt_token,
      refreshToken: dbConfig?.refresh_token,
      tmdbApiKey: dbConfig?.tmdb_api_key || '9f6dbcbddf9565f6a0f004fca81f83ee',
      rpdbApiKey: dbConfig?.rpdb_api_key,
      posterType: dbConfig?.poster_type || 'tmdb'
    };
    
    const mediaType = originalType === 'series' ? 'shows' : 'movies';
    const response = await callTraktAPI(`/${mediaType}/${traktId}?extended=full`, config);
    
    let imdbId = response.data.ids?.imdb;
    const tmdbId = response.data.ids?.tmdb;
    
    if (!imdbId && tmdbId) {
      try {
        const tmdbType = originalType === 'series' ? 'tv' : 'movie';
        const tmdbExt = await axios.get(
          `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/external_ids?api_key=${config.tmdbApiKey}`,
          { timeout: 2000, httpsAgent }
        );
        imdbId = tmdbExt.data.imdb_id;
      } catch {}
    }
    
    if (!imdbId) {
      return res.json({ meta: { id, type: originalType, name: response.data.title, description: response.data.overview || '' } });
    }
    
    let posterUrl = `https://images.metahub.space/poster/medium/${imdbId}/img`;
    let italianTitle = response.data.title;
    let italianOverview = response.data.overview || '';
    let genresItalian = response.data.genres || [];
    
    if (tmdbId) {
      try {
        const tmdbType = originalType === 'series' ? 'tv' : 'movie';
        const tmdbData = await axios.get(
          `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${config.tmdbApiKey}&language=it-IT`,
          { timeout: 3000, httpsAgent }
        );
        
        if (tmdbData.data.poster_path) {
          posterUrl = config.posterType === 'rpdb' && config.rpdbApiKey
            ? `https://api.ratingposterdb.com/${config.rpdbApiKey}/imdb/poster-default/${imdbId}.jpg`
            : `https://image.tmdb.org/t/p/w500${tmdbData.data.poster_path}`;
        }
        
        italianTitle = tmdbData.data.title || tmdbData.data.name || italianTitle;
        italianOverview = tmdbData.data.overview || italianOverview;
        genresItalian = tmdbData.data.genres?.map(g => g.name) || genresItalian;
      } catch {}
    }
    
    const meta = {
      id: imdbId,
      type: originalType,
      name: italianTitle,
      poster: posterUrl,
      background: posterUrl,
      description: italianOverview,
      releaseInfo: response.data.year?.toString() || '',
      imdbRating: response.data.rating ? response.data.rating.toFixed(1) : undefined,
      genres: genresItalian,
      runtime: response.data.runtime ? `${response.data.runtime} min` : undefined,
      language: 'it'
    };
    
    if (originalType === 'series') {
      try {
        const seasonsResp = await callTraktAPI(`/shows/${traktId}/seasons?extended=full`, config);
        const videos = [];
        
        for (const season of seasonsResp.data || []) {
          if (season.number === 0) continue;
          try {
            const epsResp = await callTraktAPI(`/shows/${traktId}/seasons/${season.number}/episodes?extended=full`, config);
            for (const ep of epsResp.data || []) {
              videos.push({
                id: `${imdbId}:${season.number}:${ep.number}`,
                title: ep.title || `Episodio ${ep.number}`,
                season: season.number,
                episode: ep.number,
                overview: ep.overview || '',
                released: ep.first_aired || ''
              });
            }
          } catch {}
        }
        
        if (tmdbId && videos.length > 0) {
          try {
            for (const season of seasonsResp.data || []) {
              if (season.number === 0) continue;
              const seasonData = await axios.get(
                `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season.number}?api_key=${config.tmdbApiKey}&language=it-IT`,
                { timeout: 2000, httpsAgent }
              );
              for (const ep of seasonData.data.episodes || []) {
                const video = videos.find(v => v.season === season.number && v.episode === ep.episode_number);
                if (video && ep.name) {
                  video.title = ep.name;
                  video.overview = ep.overview || video.overview;
                }
              }
            }
          } catch {}
        }
        
        if (videos.length > 0) meta.videos = videos;
      } catch {}
    }
    
    res.json({ meta });
  } catch {
    res.json({ meta: { id: req.params.id, type: req.params.type, name: 'Errore' } });
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

app.listen(PORT, () => {
  console.log(`✅ Server ready at ${BASE_URL}`);
  console.log(`🇮🇹 Italian metadata - ALL items`);
  console.log(`⚡ Batch processing: ${BATCH_SIZE} items at a time`);
  console.log(`📦 Returns complete catalog (no pagination)`);
  console.log(`🚀 v9.0 FINAL\n`);
});
