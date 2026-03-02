/**
 * HTMLplay GameDB — Chunked JSON Database Handler
 *
 * Architecture rationale:
 *   Loading 10,000 games as a single JSON = ~4MB cold + parse time.
 *   Instead: split into 50-game chunks, load on demand.
 *   Initial: load chunk-000 (20 games visible), rest on scroll/filter.
 *   Each chunk is ~20KB gzipped → sub-50ms load on CDN edge.
 *
 * Cloudflare edge caches chunks with immutable headers.
 * In-memory Map prevents re-fetching across same session.
 */

class GameDB {
  constructor(config = {}) {
    this.chunkSize   = config.chunkSize   || 50;
    this.baseUrl     = config.baseUrl     || '/data/chunks';
    this.indexUrl    = config.indexUrl    || '/data/games-index.json';

    this._index      = null;   // { slugToId, idToChunk, total, chunks }
    this._cache      = new Map();  // chunkId → game[]
    this._slugMap    = new Map();  // slug → game
    this._loaded     = new Set();  // chunkIds fetched

    this._inflight   = new Map();  // chunkId → Promise (dedup concurrent fetches)
  }

  /**
   * Load the lightweight index file.
   * Index only has: id, slug, title, thumbnail, category, chunk reference.
   * Full game objects live in chunks.
   */
  async loadIndex() {
    if (this._index) return this._index;
    const res  = await fetch(this.indexUrl);
    const data = await res.json();
    this._index = data;

    // Build slug → chunkId lookup
    for (const entry of data.entries) {
      this._slugMap.set(entry.slug, entry);
    }
    return this._index;
  }

  /**
   * Load a specific chunk. Returns cached version if available.
   * Deduplicates inflight requests.
   */
  async loadChunk(chunkId) {
    const key = String(chunkId).padStart(3, '0');

    if (this._cache.has(key)) return this._cache.get(key);

    // Deduplicate concurrent fetches for same chunk
    if (this._inflight.has(key)) return this._inflight.get(key);

    const promise = fetch(`${this.baseUrl}/chunk-${key}.json`)
      .then(r => r.json())
      .then(data => {
        this._cache.set(key, data.games);
        this._loaded.add(key);
        // Populate slug map with full data
        for (const game of data.games) {
          this._slugMap.set(game.slug, game);
        }
        this._inflight.delete(key);
        return data.games;
      });

    this._inflight.set(key, promise);
    return promise;
  }

  /**
   * Get paginated games from loaded chunks.
   * Triggers background loading of next chunk.
   *
   * @param {object} opts - { page, category, tags, search, sort }
   */
  async getGames({ page = 0, category = null, tags = [], search = '', sort = 'trending' } = {}) {
    await this.loadIndex();

    const pageSize = 20;
    const requiredChunk = Math.floor((page * pageSize) / this.chunkSize);

    // Load required chunk + prefetch next
    const [games] = await Promise.all([
      this.loadChunk(requiredChunk),
      this.loadChunk(requiredChunk + 1).catch(() => []),  // silent prefetch
    ]);

    let pool = [...(this._cache.get(String(requiredChunk).padStart(3, '0')) || [])];

    // Apply filters
    if (category) {
      pool = pool.filter(g => g.category === category);
    }
    if (tags.length) {
      pool = pool.filter(g => tags.some(t => g.tags?.includes(t)));
    }
    if (search) {
      const q = search.toLowerCase();
      pool = pool.filter(g =>
        g.title.toLowerCase().includes(q) ||
        g.shortDescription?.toLowerCase().includes(q) ||
        g.tags?.some(t => t.includes(q))
      );
    }

    // Sort strategies
    pool = this._sort(pool, sort);

    const offset = (page * pageSize) % this.chunkSize;
    return {
      games: pool.slice(offset, offset + pageSize),
      hasMore: pool.length > offset + pageSize || requiredChunk + 1 < this._index.totalChunks,
      total: this._index.total,
    };
  }

  /**
   * Get a single game by slug. Loads its chunk if not cached.
   */
  async getBySlug(slug) {
    await this.loadIndex();

    const entry = this._slugMap.get(slug);
    if (!entry) return null;

    if (entry.chunk !== undefined && !this._cache.has(String(entry.chunk).padStart(3,'0'))) {
      await this.loadChunk(entry.chunk);
    }

    return this._slugMap.get(slug) || null;
  }

  /**
   * Full-text search across index (lightweight, no chunk load needed for basic results).
   * Returns slim results for search dropdown; slug used to load full game on click.
   */
  async search(query, limit = 8) {
    await this.loadIndex();
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const results = [];
    for (const entry of this._index.entries) {
      if (results.length >= limit) break;
      if (
        entry.title.toLowerCase().includes(q) ||
        entry.category?.includes(q) ||
        entry.tags?.some(t => t.includes(q))
      ) {
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * Get related games by category + tag overlap.
   * Pure in-memory, no extra fetch if chunk is loaded.
   */
  async getRelated(game, limit = 6) {
    await this.loadChunk(0); // ensure at least first chunk loaded
    const pool = [...this._slugMap.values()]
      .filter(g => g.id !== game.id && g.slug !== game.slug)
      .map(g => ({
        game: g,
        score: this._relatednessScore(g, game),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.game);
    return pool;
  }

  /**
   * trendingScore formula:
   *   TS = (log10(playCount + 1) × 1000) + (recencyDecay × 500) + (ratingScore × 200)
   *
   *   recencyDecay = e^(-daysSinceAdded / 30)    → recent games boosted, fades over 30 days
   *   ratingScore  = (rating × ratingCount) / (ratingCount + 100)  → Bayesian avg to prevent manipulation
   *
   *   Manipulation prevention:
   *   - playCount stored server-side, incremented via Edge Function with IP dedup (1 count / IP / 24h)
   *   - ratingCount requires localStorage fingerprint; server validates via Turnstile
   *   - trendingScore recalculated nightly in pipeline, never client-writable
   */
  computeTrendingScore(game) {
    const now         = Date.now();
    const added       = new Date(game.dateAdded).getTime();
    const daysSince   = (now - added) / (1000 * 60 * 60 * 24);
    const playScore   = Math.log10((game.playCount || 0) + 1) * 1000;
    const recency     = Math.exp(-daysSince / 30) * 500;
    const bayesRating = ((game.rating || 0) * (game.ratingCount || 0)) / ((game.ratingCount || 0) + 100);
    const ratingScore = bayesRating * 200;
    return Math.round(playScore + recency + ratingScore);
  }

  _sort(games, sort) {
    switch (sort) {
      case 'trending':  return games.sort((a, b) => b.trendingScore - a.trendingScore);
      case 'new':       return games.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
      case 'popular':   return games.sort((a, b) => b.playCount - a.playCount);
      case 'rating':    return games.sort((a, b) => b.rating - a.rating);
      case 'az':        return games.sort((a, b) => a.title.localeCompare(b.title));
      default:          return games;
    }
  }

  _relatednessScore(candidate, target) {
    let score = 0;
    if (candidate.category === target.category) score += 40;
    if (candidate.subCategory === target.subCategory) score += 20;
    const sharedTags = (candidate.tags || []).filter(t => (target.tags || []).includes(t));
    score += sharedTags.length * 10;
    if (candidate.mobileCompatible === target.mobileCompatible) score += 5;
    return score;
  }
}

// Export singleton
window.GameDB = new GameDB();
export default window.GameDB;
