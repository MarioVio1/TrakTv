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

console.log('\n🐱💜 Trakt Ultimate v8.5 FINAL - Starting...\n');
console.log(`📍 Base URL: ${BASE_URL}`);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ⚡ OTTIMIZZAZIONI HTTP
http.globalAgent.maxSockets = 100;
https.globalAgent.maxSockets = 100;

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 2500
});

axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 3000;

// ⚡ SMART CACHE
class SmartCache {
  constructor(maxSize = 20) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }
  
  get(key) {
    return this.cache.get(key);
  }
  
  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      console.log(`🗑️ Cache full - removed: ${firstKey.substring(0, 30)}...`);
    }
    this.cache.set(key, value);
  }
  
  clear() {
    this.cache.clear();
  }
  
  get size() {
    return this.cache.size;
  }
}

const metaCache = new SmartCache(20);
const tmdbCache = new SmartCache(300);
const CACHE_DURATION = 60 * 60 * 1000; // 1 ora
const TMDB_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 ore

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, value] of metaCache.cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      metaCache.cache.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired catalogs`);
  }
}, 20 * 60 * 1000);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({ 
    status: 'ok', 
    version: '8.5.0',
    memory: `${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
    cache: { catalogs: metaCache.size, tmdb: tmdbCache.size }
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
    
    console.log(`💾 Saved config for ${config.username} with ${listsToSave.length} lists`);
    return !error;
  } catch (err) {
    console.error('❌ Save error:', err);
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
    console.log('🔄 Token refreshed');
    return response.data;
  } catch (error) {
    console.error('❌ Token refresh failed');
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
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    return await axios({
      method,
      url: `https://api.trakt.tv${endpoint}`,
      headers,
      ...(data && { data }),
      timeout: 15000
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

async function getTMDBFastCached(tmdbId, type, config) {
  const cacheKey = `tmdb:it:${type}:${tmdbId}`;
  const cached = tmdbCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < TMDB_CACHE_DURATION) {
    return cached.data;
  }
  
  try {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${config.tmdbApiKey}&language=it-IT&append_to_response=external_ids`;
    
    const response = await axios.get(url, { 
      timeout: 2500,
      headers: { 
        'Accept-Encoding': 'gzip, deflate',
        'Accept': 'application/json'
      }
    });
    
    const data = {
      title: response.data.title || response.data.name,
      overview: response.data.overview,
      poster_path: response.data.poster_path,
      imdb_id: response.data.external_ids?.imdb_id
    };
    
    tmdbCache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
    
  } catch (error) {
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

async function processBatchFast(items, config) {
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
      const tmdbData = await getTMDBFastCached(tmdbId, type, config);
      if (tmdbData) {
        italianTitle = tmdbData.title || content.title;
        italianOverview = tmdbData.overview || content.overview || '';
        posterPath = tmdbData.poster_path;
        if (tmdbData.imdb_id) imdbId = tmdbData.imdb_id;
      }
    }
    
    const posterUrl = buildPosterUrl(imdbId, posterPath, config);
    
    return {
      id: `trakt:${type}:${traktId}`,
      type: type,
      name: italianTitle,
      poster: posterUrl,
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
    const key = meta.trakt_id || meta.id;
    if (seen.has(key)) return false;
    seen.add(key);
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
  const username = req.params.username;
  
  try {
    const user = await getUserConfig(username);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const { error } = await supabase
      .from('users')
      .update({ 
        trakt_token: '',
        refresh_token: '',
        updated_at: new Date().toISOString()
      })
      .eq('username', username);
    
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Auth Reset</title>
        <style>
          body {
            font-family: Arial;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .container {
            text-align: center;
            background: rgba(255,255,255,0.1);
            padding: 40px;
            border-radius: 20px;
          }
          .btn {
            display: inline-block;
            padding: 15px 30px;
            background: white;
            color: #667eea;
            text-decoration: none;
            border-radius: 30px;
            font-weight: bold;
            margin: 10px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ Authentication Reset!</h1>
          <p>User: <strong>${username}</strong></p>
          <a href="/auth/trakt" class="btn">🔐 Re-Authenticate</a>
          <a href="/configure" class="btn">⚙️ Settings</a>
        </div>
      </body>
      </html>
    `);
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/:config/manifest.json', async (req, res) => {
  try {
    const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
    const manifestConfig = JSON.parse(configStr);
    
    const dbConfig = await getUserConfig(manifestConfig.username);
    
    if (!dbConfig) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const config = {
      username: dbConfig.username,
      customLists: dbConfig.custom_lists || []
    };
    
    const catalogs = [];
    
    if (config.customLists.length === 0) {
      catalogs.push({
        id: 'trakt-empty',
        name: '⚠️ Add lists in settings',
        type: 'traktultimate'
      });
    } else {
      config.customLists.forEach(list => {
        catalogs.push({
          id: `trakt-${list.id}`,
          name: list.customName || list.name,
          type: 'traktultimate'
        });
      });
    }
    
    res.json({
      id: 'org.trakttv.ultimate',
      version: '8.5.0',
      name: 'Trakt Ultimate',
      description: 'Your custom Trakt lists • Fast • Italiano',
      resources: [
        'catalog',
        {
          name: 'meta',
          types: ['movie', 'series'],
          idPrefixes: ['trakt:']
        }
      ],
      types: ['traktultimate'],
      catalogs: catalogs,
      idPrefixes: ['trakt'],
      background: `${BASE_URL}/IMG_1400.jpeg`,
      logo: `${BASE_URL}/IMG_1400.jpeg`,
      behaviorHints: {
        adult: false,
        p2p: false,
        configurable: true,
        configurationRequired: false
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Invalid configuration' });
  }
});

app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
  try {
    const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
    const manifestConfig = JSON.parse(configStr);
    
    const dbConfig = await getUserConfig(manifestConfig.username);
    if (!dbConfig) {
      return res.status(404).json({ error: 'User not found' });
    }
    
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
    
    let catalogId = req.params.id;
    
    if (catalogId === 'trakt-empty') {
      return res.json({ metas: [] });
    }
    
    const cacheKey = `${config.username}-${catalogId}`;
    const cached = metaCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      console.log(`📦 Cache HIT: ${catalogId} (${cached.metas.length} items)`);
      return res.json({ metas: cached.metas });
    }
    
    const listId = catalogId.replace(/^trakt-/, '');
    const list = config.customLists.find(l => l.id === listId);
    
    if (!list) {
      return res.json({ metas: [] });
    }
    
    const startTime = Date.now();
    console.log(`⚡ Loading: ${list.customName || list.name}`);
    
    try {
      let endpoint;
      let requireAuth = false;
      
      if (list.id.includes('recommended')) {
        const isMovies = list.name.toLowerCase().includes('movie');
        endpoint = isMovies ? '/recommendations/movies?limit=100' : '/recommendations/shows?limit=100';
        requireAuth = true;
      } else {
        endpoint = `/users/${list.username}/lists/${list.slug}/items`;
      }
      
      const response = await callTraktAPI(endpoint, config, 'GET', null, requireAuth);
      
      if (!response.data || response.data.length === 0) {
        return res.json({ metas: [] });
      }
      
      console.log(`  📦 ${response.data.length} items - processing with Italian TMDB...`);
      
      const BATCH_SIZE = 50;
      let allMetas = [];
      
      for (let i = 0; i < response.data.length; i += BATCH_SIZE) {
        const batch = response.data.slice(i, i + BATCH_SIZE);
        const batchMetas = await processBatchFast(batch, config);
        allMetas.push(...batchMetas);
      }
      
      allMetas = deduplicateMetas(allMetas);
      allMetas = sortMetas(allMetas, config.sortBy);
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ ${allMetas.length} items loaded in ${elapsed}s`);
      
      metaCache.set(cacheKey, {
        metas: allMetas,
        timestamp: Date.now()
      });
      
      res.json({ metas: allMetas });
      
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      res.json({ metas: [] });
    }
    
  } catch (error) {
    console.error('❌ Catalog error:', error.message);
    res.json({ metas: [] });
  }
});

app.get('/:config/meta/:type/:id.json', async (req, res) => {
  try {
    const id = req.params.id;
    const type = req.params.type;
    
    if (id.startsWith('trakt:')) {
      const parts = id.split(':');
      const originalType = parts[1];
      const traktId = parts[2];
      
      const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
      const manifestConfig = JSON.parse(configStr);
      const dbConfig = await getUserConfig(manifestConfig.username);
      
      const config = {
        traktToken: dbConfig?.trakt_token,
        refreshToken: dbConfig?.refresh_token,
        tmdbApiKey: dbConfig?.tmdb_api_key || '9f6dbcbddf9565f6a0f004fca81f83ee',
        rpdbApiKey: dbConfig?.rpdb_api_key,
        posterType: dbConfig?.poster_type || 'tmdb'
      };
      
      try {
        const mediaType = originalType === 'series' ? 'shows' : 'movies';
        const endpoint = `/${mediaType}/${traktId}?extended=full`;
        const response = await callTraktAPI(endpoint, config);
        
        let imdbId = response.data.ids?.imdb;
        const tmdbId = response.data.ids?.tmdb;
        
        if (!imdbId && tmdbId) {
          try {
            const tmdbType = originalType === 'series' ? 'tv' : 'movie';
            const tmdbUrl = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/external_ids?api_key=${config.tmdbApiKey}`;
            const tmdbExt = await axios.get(tmdbUrl, { timeout: 3000 });
            imdbId = tmdbExt.data.imdb_id;
          } catch (err) {}
        }
        
        if (!imdbId) {
          return res.json({ 
            meta: { 
              id: id,
              type: originalType, 
              name: response.data.title,
              description: response.data.overview || '',
              releaseInfo: response.data.year?.toString() || ''
            } 
          });
        }
        
        let posterUrl = `https://images.metahub.space/poster/medium/${imdbId}/img`;
        let italianTitle = response.data.title;
        let italianOverview = response.data.overview || '';
        let genresItalian = response.data.genres || [];
        
        if (tmdbId) {
          try {
            const tmdbType = originalType === 'series' ? 'tv' : 'movie';
            const cacheKey = `tmdb:meta:${tmdbType}:${tmdbId}`;
            const cached = tmdbCache.get(cacheKey);
            
            let tmdbData;
            
            if (cached && (Date.now() - cached.timestamp) < TMDB_CACHE_DURATION) {
              tmdbData = cached.data;
            } else {
              const tmdbResponse = await axios.get(
                `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${config.tmdbApiKey}&language=it-IT`,
                { timeout: 5000 }
              );
              tmdbData = tmdbResponse.data;
              tmdbCache.set(cacheKey, {  tmdbData, timestamp: Date.now() });
            }
            
            if (tmdbData.poster_path) {
              if (config.posterType === 'rpdb' && config.rpdbApiKey) {
                posterUrl = `https://api.ratingposterdb.com/${config.rpdbApiKey}/imdb/poster-default/${imdbId}.jpg`;
              } else {
                posterUrl = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`;
              }
            }
            
            if (tmdbData.title || tmdbData.name) {
              italianTitle = tmdbData.title || tmdbData.name;
            }
            
            if (tmdbData.overview) {
              italianOverview = tmdbData.overview;
            }
            
            if (tmdbData.genres && tmdbData.genres.length > 0) {
              genresItalian = tmdbData.genres.map(g => g.name);
            }
          } catch (err) {}
        }
        
        const meta = {
          id: imdbId,
          type: originalType,
          name: italianTitle,
          poster: posterUrl,
          background: posterUrl,
          description: italianOverview,
          releaseInfo: response.data.year?.toString() || '',
          imdbRating: response.data.rating ? (response.data.rating).toFixed(1) : undefined,
          genres: genresItalian,
          runtime: response.data.runtime ? `${response.data.runtime} min` : undefined,
          language: 'it'
        };
        
        if (originalType === 'series') {
          try {
            const seasonsEndpoint = `/shows/${traktId}/seasons?extended=full`;
            const seasonsResponse = await callTraktAPI(seasonsEndpoint, config);
            
            if (seasonsResponse.data && seasonsResponse.data.length > 0) {
              const videos = [];
              
              for (const season of seasonsResponse.data) {
                if (season.number === 0) continue;
                
                try {
                  const episodesEndpoint = `/shows/${traktId}/seasons/${season.number}/episodes?extended=full`;
                  const episodesResponse = await callTraktAPI(episodesEndpoint, config);
                  
                  if (episodesResponse.data && episodesResponse.data.length > 0) {
                    for (const episode of episodesResponse.data) {
                      videos.push({
                        id: `${imdbId}:${season.number}:${episode.number}`,
                        title: episode.title || `Episodio ${episode.number}`,
                        season: season.number,
                        episode: episode.number,
                        overview: episode.overview || '',
                        released: episode.first_aired || ''
                      });
                    }
                  }
                } catch (seasonErr) {}
              }
              
              if (tmdbId && videos.length > 0) {
                try {
                  const episodesTranslations = {};
                  
                  for (const season of seasonsResponse.data) {
                    if (season.number === 0) continue;
                    
                    const cacheKey = `tmdb:season:${tmdbId}:${season.number}`;
                    const cached = tmdbCache.get(cacheKey);
                    
                    let seasonData;
                    
                    if (cached && (Date.now() - cached.timestamp) < TMDB_CACHE_DURATION) {
                      seasonData = cached.data;
                    } else {
                      try {
                        const seasonUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season.number}?api_key=${config.tmdbApiKey}&language=it-IT`;
                        const seasonResponse = await axios.get(seasonUrl, { timeout: 3000 });
                        seasonData = seasonResponse.data;
                        tmdbCache.set(cacheKey, {  seasonData, timestamp: Date.now() });
                      } catch (err) {
                        continue;
                      }
                    }
                    
                    if (seasonData.episodes) {
                      for (const ep of seasonData.episodes) {
                        const key = `${season.number}-${ep.episode_number}`;
                        episodesTranslations[key] = {
                          title: ep.name,
                          overview: ep.overview
                        };
                      }
                    }
                  }
                  
                  videos.forEach(video => {
                    const key = `${video.season}-${video.episode}`;
                    const translation = episodesTranslations[key];
                    if (translation && translation.title) {
                      video.title = translation.title;
                    }
                    if (translation && translation.overview) {
                      video.overview = translation.overview;
                    }
                  });
                } catch (err) {}
              }
              
              if (videos.length > 0) {
                meta.videos = videos;
              }
            }
          } catch (err) {}
        }
        
        return res.json({ meta });
        
      } catch (error) {
        return res.json({ 
          meta: { 
            id: id, 
            type: originalType, 
            name: 'Errore caricamento' 
          } 
        });
      }
    }
    
    res.json({ 
      meta: { 
        id: id, 
        type: type,
        name: 'Contenuto'
      } 
    });
    
  } catch (error) {
    res.json({ 
      meta: { 
        id: req.params.id, 
        type: req.params.type,
        name: 'Errore'
      } 
    });
  }
});

app.get('/auth/trakt', (req, res) => {
  const state = Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64');
  const authUrl = `https://trakt.tv/oauth/authorize?client_id=${TRAKT_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=${state}`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error) return res.redirect(`/configure?error=${error}`);
  if (!code) return res.redirect(`/configure?error=missing_code`);
  
  try {
    const tokenResponse = await axios.post('https://api.trakt.tv/oauth/token', {
      code: code,
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });
    
    const userResponse = await axios.get('https://api.trakt.tv/users/me', {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID,
        'Authorization': `Bearer ${tokenResponse.data.access_token}`
      }
    });
    
    const username = userResponse.data.username;
    const existingConfig = await getUserConfig(username);
    
    const config = {
      username: username,
      traktToken: tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token,
      tmdbApiKey: existingConfig?.tmdb_api_key || '',
      rpdbApiKey: existingConfig?.rpdb_api_key || '',
      posterType: existingConfig?.poster_type || 'tmdb',
      customLists: existingConfig?.custom_lists || [],
      sortBy: existingConfig?.sort_by || 'default'
    };
    
    await saveUserConfig(config);
    metaCache.clear();
    
    console.log(`✅ ${username} authenticated`);
    res.redirect(`/configure?success=1&username=${username}`);
    
  } catch (error) {
    console.error('❌ Auth error:', error.message);
    res.redirect('/configure?error=auth_failed');
  }
});

app.get('/api/load-config', async (req, res) => {
  try {
    const username = req.query.username;
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }
    
    const config = await getUserConfig(username);
    if (config) {
      res.json(config);
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/save-config', async (req, res) => {
  try {
    const config = req.body;
    if (!config.username) {
      return res.status(400).json({ error: 'Username required' });
    }
    
    const saved = await saveUserConfig(config);
    metaCache.clear();
    
    if (saved) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to save' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server ready at ${BASE_URL}`);
  console.log(`💾 Cache: max 20 catalogs (1h), 300 TMDB items (24h)`);
  console.log(`🇮🇹 Italian metadata enabled with fast processing`);
  console.log(`⚡ Batch size: 50 items - Parallel TMDB calls`);
  console.log(`🚀 v8.5 FINAL - All optimizations active\n`);
});
