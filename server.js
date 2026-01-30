const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 7860;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TRAKT_CLIENT_ID = '9cf5e07c0fa71537ded08bd2c9a672f2d8ab209be584db531c0d82535027bb13';
const TRAKT_CLIENT_SECRET = 'f91521782bf59a7a5c78634821254673b16a62f599ba9f8aa17ba3040a47114c';
const BASE_URL = 'https://mariowaru-traktv.hf.space';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

console.log('\n🐱💜 Trakt Ultimate v8.1 - STABLE - Starting...\n');

app.use(cors());
app.use(express.json());
app.use('/configure', express.static(path.join(__dirname, 'configure')));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/health', (req, res) => res.json({ status: 'ok', version: '8.1.0' }));

const metaCache = new Map();
const tmdbCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000;
const TMDB_CACHE_DURATION = 24 * 60 * 60 * 1000;

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
    console.log('🔄 Token refreshed successfully');
    return response.data;
  } catch (error) {
    console.error('❌ Token refresh failed:', error.response?.data || error.message);
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
      console.log('🔄 Attempting token refresh...');
      const newTokens = await refreshAccessToken(config.refreshToken);
      
      if (newTokens) {
        config.traktToken = newTokens.access_token;
        config.refreshToken = newTokens.refresh_token;
        await saveUserConfig(config);
        return await makeRequest(newTokens.access_token);
      }
    }
    
    if (error.response?.status === 401 && !requireAuth) {
      console.log('⚠️ Trying without authentication (public list)...');
      return await makeRequest(null);
    }
    
    throw error;
  }
}

async function getTMDBData(tmdbId, type, config) {
  if (!tmdbId) return { imdb_id: null, poster_path: null, overview: null, title: null };
  
  const cacheKey = `tmdb:${type}:${tmdbId}`;
  const cached = tmdbCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < TMDB_CACHE_DURATION) {
    return cached.data;
  }
  
  try {
    const tmdbKey = config.tmdbApiKey || '9f6dbcbddf9565f6a0f004fca81f83ee';
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${tmdbKey}&language=it-IT&append_to_response=external_ids`;
    const response = await axios.get(url, { timeout: 5000 });
    
    const data = {
      imdb_id: response.data.external_ids?.imdb_id,
      poster_path: response.data.poster_path,
      overview: response.data.overview,
      title: response.data.title || response.data.name
    };
    
    tmdbCache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    return { imdb_id: null, poster_path: null, overview: null, title: null };
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
  
  return 'https://via.placeholder.com/500x750/8B7BB8/FFFFFF?text=Trakt';
}

async function convertToMetas(items, config) {
  const promises = items.map(async (item) => {
    const content = item.show || item.movie || item;
    const type = item.show ? 'series' : 'movie';
    
    let imdbId = content.ids?.imdb;
    const tmdbId = content.ids?.tmdb;
    const traktId = content.ids?.trakt;
    let posterPath = null;
    let italianOverview = null;
    let italianTitle = null;
    
    if (tmdbId) {
      const tmdbData = await getTMDBData(tmdbId, type, config);
      if (tmdbData.imdb_id) {
        imdbId = tmdbData.imdb_id;
      }
      posterPath = tmdbData.poster_path;
      italianOverview = tmdbData.overview;
      italianTitle = tmdbData.title;
    }
    
    if (!traktId) return null;
    
    const posterUrl = buildPosterUrl(imdbId, posterPath, config);
    const customId = `trakt:${type}:${traktId}`;
    
    return {
      id: customId,
      type: type,
      name: italianTitle || content.title,
      poster: posterUrl,
      description: italianOverview || content.overview || '',
      releaseInfo: content.year?.toString(),
      imdbRating: content.rating ? (content.rating / 10).toFixed(1) : undefined,
      genres: content.genres,
      imdb_id: imdbId,
      trakt_id: traktId,
      tmdb_id: tmdbId,
      _originalType: type
    };
  });
  
  const metas = await Promise.all(promises);
  return metas.filter(m => m !== null);
}

function deduplicateMetas(metas) {
  const seen = new Set();
  const unique = [];
  
  for (const meta of metas) {
    const key = meta.trakt_id || meta.id;
    
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(meta);
    }
  }
  
  if (metas.length !== unique.length) {
    console.log(`  🔍 Deduplication: ${metas.length} → ${unique.length} items`);
  }
  
  return unique;
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
  
  console.log(`🔄 Reset auth request for: ${username}`);
  
  try {
    const user = await getUserConfig(username);
    
    if (!user) {
      return res.status(404).json({ 
        error: 'User not found',
        username: username 
      });
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
      console.error(`❌ Reset failed:`, error);
      return res.status(500).json({ error: error.message });
    }
    
    console.log(`✅ Auth reset successful for ${username}`);
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Auth Reset - Trakt Ultimate</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .container {
            text-align: center;
            background: rgba(255,255,255,0.1);
            padding: 40px;
            border-radius: 20px;
            backdrop-filter: blur(10px);
            max-width: 500px;
          }
          h1 { margin-bottom: 10px; }
          p { margin: 20px 0; font-size: 18px; }
          .btn {
            display: inline-block;
            padding: 15px 30px;
            background: white;
            color: #667eea;
            text-decoration: none;
            border-radius: 30px;
            font-weight: bold;
            margin: 10px;
            transition: transform 0.2s;
          }
          .btn:hover {
            transform: scale(1.05);
          }
          .success {
            font-size: 60px;
            margin-bottom: 20px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success">✅</div>
          <h1>Authentication Reset!</h1>
          <p>User: <strong>${username}</strong></p>
          <p>Old tokens removed. Get fresh tokens:</p>
          <a href="/auth/trakt" class="btn">🔐 Re-Authenticate</a>
          <br>
          <a href="/configure" class="btn">⚙️ Settings</a>
        </div>
      </body>
      </html>
    `);
    
  } catch (err) {
    console.error(`❌ Reset error:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/:config/manifest.json', async (req, res) => {
  try {
    const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
    const manifestConfig = JSON.parse(configStr);
    
    console.log(`📋 Manifest request for user: ${manifestConfig.username}`);
    
    const dbConfig = await getUserConfig(manifestConfig.username);
    
    if (!dbConfig) {
      console.error(`❌ User not found: ${manifestConfig.username}`);
      return res.status(404).json({ error: 'User not found' });
    }
    
    const config = {
      username: dbConfig.username,
      traktToken: dbConfig.trakt_token,
      refreshToken: dbConfig.refresh_token,
      tmdbApiKey: dbConfig.tmdb_api_key,
      rpdbApiKey: dbConfig.rpdb_api_key,
      posterType: dbConfig.poster_type,
      customLists: dbConfig.custom_lists || [],
      sortBy: dbConfig.sort_by
    };
    
    console.log(`📝 User has ${config.customLists.length} custom lists`);
    
    const catalogs = [];
    
    if (config.customLists.length === 0) {
      console.log('⚠️ No custom lists found');
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
      version: '8.1.0',
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
    console.error('❌ Manifest error:', error);
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
      tmdbApiKey: dbConfig.tmdb_api_key,
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
      console.log(`📦 Cache HIT for ${catalogId}`);
      return res.json({ metas: cached.metas });
    }
    
    let metas = [];
    const listId = catalogId.replace(/^trakt-/, '');
    const list = config.customLists.find(l => l.id === listId);
    
    if (list) {
      console.log(`📥 Fetching: ${list.customName || list.name}`);
      
      try {
        let endpoint;
        let requireAuth = false;
        let isRecommended = false;
        
        if (list.id === 'recommended-movies' || (list.name.toLowerCase().includes('recommended') && list.name.toLowerCase().includes('movie'))) {
          endpoint = '/recommendations/movies?limit=100';
          requireAuth = true;
          isRecommended = true;
          console.log('  📌 Recommended movies (limit 100)');
        } else if (list.id === 'recommended-series' || (list.name.toLowerCase().includes('recommended') && (list.name.toLowerCase().includes('series') || list.name.toLowerCase().includes('show')))) {
          endpoint = '/recommendations/shows?limit=100';
          requireAuth = true;
          isRecommended = true;
          console.log('  📌 Recommended shows (limit 100)');
        } else if (!list.username || !list.slug) {
          console.error('  ❌ Invalid list: missing username or slug');
          return res.json({ metas: [] });
        } else {
          endpoint = `/users/${list.username}/lists/${list.slug}/items`;
          console.log('  📌 Custom list (no limit)');
        }
        
        const response = await callTraktAPI(endpoint, config, 'GET', null, requireAuth);
        
        if (response.data && response.data.length > 0) {
          let items;
          
          if (isRecommended) {
            items = response.data.slice(0, 100);
            console.log(`  📦 Raw items: ${response.data.length} → limited to 100`);
          } else {
            items = response.data;
            console.log(`  📦 Raw items: ${items.length} (all)`);
          }
          
          metas = await convertToMetas(items, config);
          metas = deduplicateMetas(metas);
          
          console.log(`✅ ${metas.length} unique items (FAST with Italian metadata)`);
        } else {
          console.log(`⚠️ Empty response`);
        }
      } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        
        if (list.id.includes('recommended')) {
          console.error('  💡 Tip: Use /reset-auth/YOUR_USERNAME to get fresh tokens');
        }
      }
    } else {
      console.log(`⚠️ List not found: ${listId}`);
    }
    
    metas = sortMetas(metas, config.sortBy);
    
    metaCache.set(cacheKey, {
      metas,
      timestamp: Date.now()
    });
    
    res.json({ metas });
    
  } catch (error) {
    console.error('❌ Catalog error:', error.message);
    res.json({ metas: [] });
  }
});

app.get('/:config/meta/:type/:id.json', async (req, res) => {
  try {
    const id = req.params.id;
    const type = req.params.type;
    
    console.log(`🔍 Meta request: ${type}/${id}`);
    
    if (id.startsWith('trakt:')) {
      const parts = id.split(':');
      const originalType = parts[1];
      const traktId = parts[2];
      
      console.log(`  📌 Decoded: type=${originalType}, traktId=${traktId}`);
      
      const configStr = Buffer.from(req.params.config, 'base64').toString('utf-8');
      const manifestConfig = JSON.parse(configStr);
      const dbConfig = await getUserConfig(manifestConfig.username);
      
      const config = {
        traktToken: dbConfig?.trakt_token,
        refreshToken: dbConfig?.refresh_token,
        tmdbApiKey: dbConfig?.tmdb_api_key || '9f6dbcbddf9565f6a0f004fca81f83ee'
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
            console.log(`  🔍 Found IMDB via TMDB: ${imdbId}`);
          } catch (err) {
            console.log('  ⚠️ No IMDB ID found');
          }
        }
        
        if (!imdbId) {
          console.log(`  ⚠️ No IMDB ID - using trakt ID fallback`);
          return res.json({ 
            meta: { 
              id: `trakt:${originalType}:${traktId}`,
              type: originalType, 
              name: response.data.title,
              description: response.data.overview || 'Nessuna descrizione disponibile',
              releaseInfo: response.data.year?.toString() || '',
              poster: `https://via.placeholder.com/500x750/8B7BB8/FFFFFF?text=${encodeURIComponent(response.data.title)}`
            } 
          });
        }
        
        console.log(`  ✅ Found IMDB: ${imdbId} (type: ${originalType})`);
        
        let posterUrl = `https://images.metahub.space/poster/medium/${imdbId}/img`;
        let italianTitle = response.data.title;
        let italianOverview = response.data.overview || 'Nessuna descrizione disponibile';
        let genresItalian = response.data.genres || [];
        
        if (tmdbId) {
          try {
            const tmdbType = originalType === 'series' ? 'tv' : 'movie';
            const tmdbResponse = await axios.get(
              `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${config.tmdbApiKey}&language=it-IT`,
              { timeout: 5000 }
            );
            
            if (tmdbResponse.data.poster_path) {
              posterUrl = `https://image.tmdb.org/t/p/w500${tmdbResponse.data.poster_path}`;
            }
            
            if (tmdbResponse.data.title || tmdbResponse.data.name) {
              italianTitle = tmdbResponse.data.title || tmdbResponse.data.name;
            }
            
            if (tmdbResponse.data.overview) {
              italianOverview = tmdbResponse.data.overview;
            }
            
            if (tmdbResponse.data.genres && tmdbResponse.data.genres.length > 0) {
              genresItalian = tmdbResponse.data.genres.map(g => g.name);
            }
            
            console.log(`  🇮🇹 Italian metadata loaded`);
          } catch (err) {
            console.log('  ⚠️ TMDB Italian metadata fetch failed');
          }
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
          country: response.data.country,
          language: 'it'
        };
        
        if (originalType === 'series') {
          try {
            console.log(`  📺 Fetching episodes...`);
            
            const seasonsEndpoint = `/shows/${traktId}/seasons?extended=full`;
            const seasonsResponse = await callTraktAPI(seasonsEndpoint, config);
            
            if (!seasonsResponse.data || seasonsResponse.data.length === 0) {
              console.log(`  ⚠️ No seasons found`);
            } else {
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
                    console.log(`  ✅ Season ${season.number}: ${episodesResponse.data.length} episodes`);
                  }
                } catch (seasonErr) {
                  console.log(`  ⚠️ Failed season ${season.number}`);
                }
              }
              
              if (tmdbId && videos.length > 0) {
                try {
                  const episodesTranslations = {};
                  
                  for (const season of seasonsResponse.data) {
                    if (season.number === 0) continue;
                    
                    try {
                      const seasonUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season.number}?api_key=${config.tmdbApiKey}&language=it-IT`;
                      const seasonData = await axios.get(seasonUrl, { timeout: 3000 });
                      
                      if (seasonData.data.episodes) {
                        for (const ep of seasonData.data.episodes) {
                          const key = `${season.number}-${ep.episode_number}`;
                          episodesTranslations[key] = {
                            title: ep.name,
                            overview: ep.overview
                          };
                        }
                      }
                    } catch (err) {}
                  }
                  
                  let translatedCount = 0;
                  videos.forEach(video => {
                    const key = `${video.season}-${video.episode}`;
                    const translation = episodesTranslations[key];
                    if (translation && translation.title) {
                      video.title = translation.title;
                      translatedCount++;
                    }
                    if (translation && translation.overview) {
                      video.overview = translation.overview;
                    }
                  });
                  
                  if (translatedCount > 0) {
                    console.log(`  🇮🇹 ${translatedCount} Italian titles applied`);
                  }
                } catch (err) {
                  console.log('  ⚠️ Italian translation skipped');
                }
              }
              
              if (videos.length > 0) {
                meta.videos = videos;
                console.log(`  ✅ Total episodes: ${videos.length}`);
              }
            }
          } catch (err) {
            console.log('  ❌ Episodes fetch failed:', err.message);
          }
        }
        
        console.log(`  ✅ Meta response: ${meta.name} (${imdbId}) [IT]`);
        return res.json({ meta });
        
      } catch (error) {
        console.error('  ❌ Trakt lookup failed:', error.message);
        return res.json({ 
          meta: { 
            id: id, 
            type: originalType, 
            name: 'Errore caricamento contenuto' 
          } 
        });
      }
    }
    
    console.log('  ℹ️ Standard ID, passthrough');
    res.json({ 
      meta: { 
        id: id, 
        type: type,
        name: 'Contenuto'
      } 
    });
    
  } catch (error) {
    console.error('❌ Meta error:', error.message);
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
    
    console.log(`✅ ${username} authenticated - ${config.customLists.length} lists preserved`);
    res.redirect(`/configure?success=1&username=${username}`);
    
  } catch (error) {
    console.error('❌ Auth error:', error.response?.data || error.message);
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
  console.log(`✅ Server ready at http://localhost:${PORT}`);
  console.log(`🔗 Auth: ${BASE_URL}/auth/trakt`);
  console.log(`🔄 Reset: ${BASE_URL}/reset-auth/USERNAME`);
  console.log(`🐱💜 v8.1 - STABLE VERSION`);
});
