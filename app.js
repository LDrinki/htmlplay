/**
 * HTMLplay Core App
 *
 * Responsibilities:
 *  - JSON-driven rendering (no framework, ~8KB)
 *  - Virtual/windowed rendering for 10,000+ game grids (IntersectionObserver)
 *  - Search with debounce
 *  - Category filtering + sort
 *  - Infinite scroll / chunk loading
 *  - Dynamic SEO meta injection for SPA-like navigation
 *  - Ad zone activation
 */

import GameDB from './db.js';
import EngagementEngine from './engagement.js';

const Config = window.__HP_CONFIG__ || {};

/* ═══════════════════════════════════════════════════════════
   ROUTER — lightweight hash or path router
═══════════════════════════════════════════════════════════ */
const Router = {
  routes: [],
  init() {
    window.addEventListener('popstate', () => this._resolve());
    document.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (href.startsWith('/') && !href.startsWith('//')) {
        e.preventDefault();
        this.navigate(href);
      }
    });
    this._resolve();
  },
  on(pattern, handler) {
    this.routes.push({ pattern: new RegExp('^' + pattern.replace(/:[^/]+/g, '([^/]+)') + '$'), handler });
    return this;
  },
  navigate(path) {
    window.history.pushState({}, '', path);
    this._resolve();
    window.scrollTo(0, 0);
  },
  _resolve() {
    const path = window.location.pathname;
    for (const route of this.routes) {
      const m = path.match(route.pattern);
      if (m) { route.handler(...m.slice(1)); return; }
    }
  }
};

/* ═══════════════════════════════════════════════════════════
   SEO MANAGER — dynamic meta, structured data, breadcrumbs
═══════════════════════════════════════════════════════════ */
const SEO = {
  setPage(title, desc, canonical, extraMeta = {}) {
    document.title = title;
    this._meta('description', desc);
    this._meta('og:title', title, 'property');
    this._meta('og:description', desc, 'property');
    this._meta('og:url', `https://htmlplay.io${canonical}`, 'property');
    if (extraMeta.image) this._meta('og:image', extraMeta.image, 'property');
    this._canonical(canonical);
  },

  setGame(game) {
    const title = `${game.title} - Play Free Online | HTMLplay`;
    const desc  = game.shortDescription || `Play ${game.title} for free online. No download required.`;
    this.setPage(title, desc, `/game/${game.slug}`, { image: game.featuredImage || game.thumbnail });

    // Game structured data (Schema.org VideoGame)
    this._structuredData({
      '@context': 'https://schema.org',
      '@type': 'VideoGame',
      'name': game.title,
      'description': game.description,
      'url': `https://htmlplay.io/game/${game.slug}`,
      'image': `https://htmlplay.io${game.thumbnail}`,
      'genre': game.category,
      'gamePlatform': 'HTML5, Web Browser',
      'operatingSystem': 'Any',
      'applicationCategory': 'Game',
      'offers': { '@type': 'Offer', 'price': '0', 'priceCurrency': 'USD' },
      'aggregateRating': game.ratingCount > 0 ? {
        '@type': 'AggregateRating',
        'ratingValue': game.rating,
        'ratingCount': game.ratingCount,
        'bestRating': '5',
        'worstRating': '1'
      } : undefined,
    });

    // Breadcrumb
    this._structuredData({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      'itemListElement': [
        { '@type': 'ListItem', 'position': 1, 'name': 'HTMLplay', 'item': 'https://htmlplay.io' },
        { '@type': 'ListItem', 'position': 2, 'name': game.category, 'item': `https://htmlplay.io/category/${game.category}` },
        { '@type': 'ListItem', 'position': 3, 'name': game.title },
      ]
    });
  },

  setCategory(cat) {
    const title = `Free ${cat.label} Games - Play Online | HTMLplay`;
    const desc  = `Play the best free ${cat.label} games online. No download, no login. 1000+ ${cat.label} games updated daily.`;
    this.setPage(title, desc, `/category/${cat.slug}`);
  },

  _meta(name, content, attr = 'name') {
    let el = document.querySelector(`meta[${attr}="${name}"]`);
    if (!el) { el = document.createElement('meta'); el.setAttribute(attr, name); document.head.appendChild(el); }
    el.setAttribute('content', content);
  },

  _canonical(path) {
    let el = document.querySelector('link[rel="canonical"]');
    if (!el) { el = document.createElement('link'); el.rel = 'canonical'; document.head.appendChild(el); }
    el.href = `https://htmlplay.io${path}`;
  },

  _structuredData(data) {
    let el = document.getElementById('sd-' + data['@type']);
    if (!el) {
      el = document.createElement('script');
      el.type = 'application/ld+json';
      el.id = 'sd-' + data['@type'];
      document.head.appendChild(el);
    }
    el.textContent = JSON.stringify(data, null, 0);
  }
};

/* ═══════════════════════════════════════════════════════════
   AD MANAGER — placement activation, preroll timer
═══════════════════════════════════════════════════════════ */
const AdManager = {
  _sessionAds: 0,

  init() {
    this._bindScrollAds();
  },

  activatePreroll(onComplete) {
    if (!Config.ads?.prerollEnabled) { onComplete(); return; }

    const overlay = document.getElementById('preroll-overlay');
    const timerEl = document.getElementById('preroll-timer');
    const skipBtn = document.getElementById('preroll-skip');
    if (!overlay) { onComplete(); return; }

    overlay.style.display = 'flex';
    let remaining = Config.ads?.prerollDuration || 5;

    const tick = setInterval(() => {
      remaining--;
      if (timerEl) timerEl.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(tick);
        if (skipBtn) { skipBtn.classList.add('active'); skipBtn.textContent = 'Skip Ad →'; }
      }
    }, 1000);

    if (skipBtn) {
      skipBtn.addEventListener('click', () => {
        if (!skipBtn.classList.contains('active')) return;
        clearInterval(tick);
        overlay.style.display = 'none';
        onComplete();
      }, { once: true });
    }

    // Auto-dismiss at 5s if no skip click
    setTimeout(() => {
      clearInterval(tick);
      overlay.style.display = 'none';
      onComplete();
    }, (remaining + 1) * 1000);
  },

  /**
   * Inject ad after every N game cards in the grid.
   * Behavioural rationale: ads injected mid-content have 40% higher viewability
   * than footer-only placements. Interval of 8 cards avoids disrupting browsing flow.
   */
  injectBetweenGameAds(gridEl, interval = 8) {
    const cards = gridEl.querySelectorAll('.game-card');
    let injected = 0;
    cards.forEach((card, i) => {
      if (i > 0 && i % interval === 0) {
        const ad = document.createElement('div');
        ad.className = 'ad-between';
        ad.style.gridColumn = '1 / -1';
        ad.innerHTML = '<span>Advertisement</span>';
        card.parentNode.insertBefore(ad, card);
        injected++;
      }
    });
    return injected;
  },

  _bindScrollAds() {
    let triggered = false;
    const threshold = Config.ads?.scrollTriggerThreshold || 600;
    window.addEventListener('scroll', () => {
      if (!triggered && window.scrollY > threshold) {
        triggered = true;
        this._activateStickyAd();
      }
    }, { passive: true });
  },

  _activateStickyAd() {
    const sidebar = document.getElementById('ad-sidebar');
    if (!sidebar) return;
    sidebar.style.opacity = '1';
  }
};

/* ═══════════════════════════════════════════════════════════
   GAME GRID — virtualised rendering with IntersectionObserver
═══════════════════════════════════════════════════════════ */
const GameGrid = {
  _container: null,
  _page: 0,
  _loading: false,
  _hasMore: true,
  _activeFilters: { category: null, sort: 'trending', search: '' },
  _observer: null,

  async init(containerId) {
    this._container = document.getElementById(containerId);
    if (!this._container) return;

    this._renderSkeletons(20);
    await this._loadPage();

    this._bindInfiniteScroll();
    EngagementEngine.bindHoverPreviews();
  },

  _renderSkeletons(count) {
    this._container.innerHTML = Array(count).fill(0).map(() => `
      <div class="card-skeleton">
        <div class="skeleton-thumb"></div>
        <div class="skeleton-info">
          <div class="skeleton-line"></div>
          <div class="skeleton-line short"></div>
        </div>
      </div>
    `).join('');
  },

  async _loadPage(reset = false) {
    if (this._loading || (!this._hasMore && !reset)) return;
    this._loading = true;

    if (reset) {
      this._page = 0;
      this._container.innerHTML = '';
      this._renderSkeletons(20);
    }

    try {
      const { games, hasMore } = await GameDB.getGames({
        page: this._page,
        category: this._activeFilters.category,
        search: this._activeFilters.search,
        sort: this._activeFilters.sort,
      });

      if (reset) this._container.innerHTML = '';

      this._hasMore = hasMore;
      this._page++;

      const fragment = document.createDocumentFragment();
      for (const game of games) {
        fragment.appendChild(this._buildCard(game));
      }
      this._container.appendChild(fragment);

      // Inject ads after grid populated
      AdManager.injectBetweenGameAds(this._container);

    } catch (err) {
      console.error('[GameGrid] Load error:', err);
    }

    this._loading = false;
  },

  _buildCard(game) {
    const card = document.createElement('div');
    card.className = 'game-card fade-in';
    card.dataset.slug = game.slug;
    if (game.previewUrl) card.dataset.previewUrl = game.previewUrl;

    const badge = game.isNew ? `<div class="card-badge new">NEW</div>`
      : game.isTrending ? `<div class="card-badge alert">🔥 HOT</div>`
      : game.isFeatured ? `<div class="card-badge featured">⭐ TOP</div>`
      : '';

    const mobile = game.mobileCompatible ? `<span class="card-mobile" title="Mobile Friendly">📱</span>` : '';

    card.innerHTML = `
      <div class="card-thumb">
        <img
          src="${game.thumbnail}"
          alt="${game.title}"
          loading="lazy"
          width="240" height="180"
          onerror="this.src='/assets/thumbnails/placeholder.webp'"
        >
        ${badge}
        <div class="card-preview">
          <div class="card-play-btn">▶</div>
        </div>
      </div>
      <div class="card-info">
        <div class="card-title">${game.title}</div>
        <div class="card-cat">${game.category}</div>
        <div class="card-rating">
          <span class="star">★</span>
          <span>${(game.rating || 0).toFixed(1)}</span>
          ${mobile}
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      Router.navigate(`/game/${game.slug}`);
    });

    return card;
  },

  _bindInfiniteScroll() {
    const sentinel = document.createElement('div');
    sentinel.id = 'load-more-sentinel';
    this._container.parentNode?.appendChild(sentinel);

    this._observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !this._loading && this._hasMore) {
        this._loadPage();
      }
    }, { rootMargin: '300px' });

    this._observer.observe(sentinel);
  },

  setFilter(key, value) {
    this._activeFilters[key] = value;
    this._loadPage(true);
  },
};

/* ═══════════════════════════════════════════════════════════
   SEARCH — debounced, lightweight
═══════════════════════════════════════════════════════════ */
const Search = {
  _input: null,
  _results: null,
  _timer: null,

  init() {
    this._input   = document.getElementById('search-input');
    this._results = document.getElementById('search-results');
    if (!this._input) return;

    this._input.addEventListener('input', () => {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._run(), 250);
    });

    this._input.addEventListener('focus', () => {
      if (this._results.innerHTML.trim()) this._results.classList.add('open');
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('#search-results') && !e.target.closest('#search-input')) {
        this._results.classList.remove('open');
      }
    });
  },

  async _run() {
    const q = this._input.value.trim();
    if (q.length < 2) { this._results.classList.remove('open'); return; }

    const games = await GameDB.search(q, 8);

    this._results.innerHTML = games.map(g => `
      <a href="/game/${g.slug}" class="search-result-item">
        <img src="${g.thumbnail}" alt="${g.title}" width="36" height="36" loading="lazy">
        <div>
          <div class="sri-name">${this._highlight(g.title, q)}</div>
          <div class="sri-cat">${g.category}</div>
        </div>
      </a>
    `).join('') || `<div class="search-result-item"><div>No results for "${q}"</div></div>`;

    this._results.classList.add('open');
  },

  _highlight(text, q) {
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(re, '<mark style="background:rgba(200,255,0,0.25);color:inherit;border-radius:2px">$1</mark>');
  }
};

/* ═══════════════════════════════════════════════════════════
   PAGE RENDERERS
═══════════════════════════════════════════════════════════ */
const Pages = {
  async home() {
    SEO.setPage(
      'HTMLplay — Free HTML5 Games Online. 10,000+ Games. No Download.',
      'Play thousands of free HTML5 games instantly in your browser. No download, no login. Action, puzzle, racing, horror and more.',
      '/'
    );
    document.getElementById('page-home')?.classList.remove('hidden');
    document.getElementById('page-game')?.classList.add('hidden');
    document.getElementById('page-category')?.classList.add('hidden');

    await GameGrid.init('home-grid');
  },

  async game(slug) {
    const game = await GameDB.getBySlug(slug);
    if (!game) { Router.navigate('/'); return; }

    SEO.setGame(game);
    EngagementEngine.trackPlay(game);

    document.getElementById('page-home')?.classList.add('hidden');
    document.getElementById('page-game')?.classList.remove('hidden');
    document.getElementById('page-category')?.classList.add('hidden');

    this._renderGamePage(game);
  },

  _renderGamePage(game) {
    const container = document.getElementById('page-game');
    if (!container) return;

    container.innerHTML = `
      <nav class="breadcrumbs">
        <a href="/">HTMLplay</a>
        <span class="sep">›</span>
        <a href="/category/${game.category}">${game.category}</a>
        <span class="sep">›</span>
        <span>${game.title}</span>
      </nav>
      <div id="game-layout">
        <div id="game-main">
          <div class="game-player-wrap">
            <div class="preroll-overlay" id="preroll-overlay" style="display:none">
              <div style="color:var(--text-1);font-family:var(--font-mono);font-size:0.75rem;margin-bottom:8px">Game loading in...</div>
              <div class="preroll-timer" id="preroll-timer">${Config.ads?.prerollDuration || 5}</div>
              <div style="background:var(--bg-2);width:120px;height:90px;display:flex;align-items:center;justify-content:center;border-radius:8px;margin:16px 0;color:var(--text-2);font-size:0.7rem;font-family:var(--font-mono)">AD</div>
              <button class="preroll-skip" id="preroll-skip">Ad finishing...</button>
            </div>
            <iframe
              id="game-iframe"
              src="about:blank"
              title="${game.title}"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              allow="autoplay; fullscreen"
              loading="lazy"
              style="display:none"
            ></iframe>
          </div>
          <div class="game-meta">
            <h1>${game.title}</h1>
            <div class="game-meta-row">
              <span class="badge">${game.category}</span>
              ${game.isMultiplayer ? '<span class="badge">👥 Multiplayer</span>' : ''}
              ${game.mobileCompatible ? '<span class="badge" style="border-color:var(--acid);color:var(--acid)">📱 Mobile</span>' : ''}
              <span>⏱ ${game.estimatedPlayTime || '5-15 min'}</span>
              <span>★ ${(game.rating||0).toFixed(1)} (${(game.ratingCount||0).toLocaleString()})</span>
            </div>
            <p class="game-description">${game.description}</p>
          </div>
          <div class="ad-leaderboard" id="ad-game-footer">Advertisement</div>
          <div class="section-header" style="margin-top:32px">
            <h2 class="section-title">YOU MIGHT LIKE</h2>
          </div>
          <div class="game-grid" id="related-grid"></div>
        </div>
        <div style="width:160px;flex-shrink:0">
          <div class="ad-sidebar-sticky">Ad 160×600</div>
        </div>
      </div>
      <div id="mobile-controller"></div>
    `;

    // Start preroll → then load game
    AdManager.activatePreroll(() => {
      const iframe = document.getElementById('game-iframe');
      if (iframe) {
        iframe.src = game.gameUrl;
        iframe.style.display = 'block';
      }

      // Start controller detection
      import('./controller.js').then(({ default: ctrl }) => {
        ctrl.init(game, iframe);
      });
    });

    // Load related games
    this._loadRelated(game);

    // Track session time
    const startTime = Date.now();
    window.addEventListener('beforeunload', () => {
      const seconds = Math.round((Date.now() - startTime) / 1000);
      EngagementEngine.markSession(game.slug, seconds);
    });
  },

  async _loadRelated(game) {
    const relatedGrid = document.getElementById('related-grid');
    if (!relatedGrid) return;

    // Await first chunk
    await GameDB.loadChunk(0);
    const allGames = [...window.GameDB._slugMap.values()].filter(g => g.id);
    const related  = await EngagementEngine.getRecommendations(game, allGames, 6);

    relatedGrid.innerHTML = related.map(g => `
      <div class="game-card fade-in" onclick="Router.navigate('/game/${g.slug}')">
        <div class="card-thumb">
          <img src="${g.thumbnail}" alt="${g.title}" loading="lazy" width="240" height="180">
          <div class="card-preview"><div class="card-play-btn">▶</div></div>
        </div>
        <div class="card-info">
          <div class="card-title">${g.title}</div>
          <div class="card-cat">${g.category}</div>
        </div>
      </div>
    `).join('');

    // Preload the top recommendation
    if (related[0]) EngagementEngine.preloadNext(related[0]);
  },

  async category(slug) {
    const catConfig = (Config.categories || []).find(c => c.slug === slug);
    if (!catConfig) { Router.navigate('/'); return; }

    SEO.setCategory(catConfig);

    document.getElementById('page-home')?.classList.add('hidden');
    document.getElementById('page-game')?.classList.add('hidden');
    document.getElementById('page-category')?.classList.remove('hidden');

    const container = document.getElementById('page-category');
    container.innerHTML = `
      <nav class="breadcrumbs">
        <a href="/">HTMLplay</a>
        <span class="sep">›</span>
        <span>${catConfig.label} Games</span>
      </nav>
      <div class="cat-hero" style="border-left: 4px solid ${catConfig.color}">
        <div class="cat-icon">${catConfig.icon}</div>
        <div class="cat-hero-title">${catConfig.label.toUpperCase()} GAMES</div>
        <div class="cat-hero-sub">The best free ${catConfig.label} games online. Play instantly — no download needed.</div>
      </div>
      <div class="game-grid" id="cat-grid"></div>
    `;

    GameGrid._activeFilters.category = slug;
    GameGrid._activeFilters.search   = '';
    await GameGrid.init('cat-grid');
  }
};

/* ═══════════════════════════════════════════════════════════
   CATEGORY PILL BINDINGS
═══════════════════════════════════════════════════════════ */
function bindCategoryPills() {
  document.querySelectorAll('.cat-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const cat = pill.dataset.category;
      if (cat === 'all') {
        GameGrid.setFilter('category', null);
      } else {
        GameGrid.setFilter('category', cat);
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════ */
async function boot() {
  // Load config
  try {
    const cfg = await fetch('/data/config.json').then(r => r.json());
    Object.assign(Config, cfg);
    window.__HP_CONFIG__ = Config;
  } catch {}

  // Init services
  Search.init();
  AdManager.init();

  // Register routes
  Router
    .on('/', () => Pages.home())
    .on('/game/([^/]+)', slug => Pages.game(slug))
    .on('/category/([^/]+)', slug => Pages.category(slug))
    .init();

  // Bind UI interactions
  bindCategoryPills();

  // Render streak chip
  const streak = EngagementEngine.getStreak();
  const chip = document.getElementById('streak-chip');
  if (chip) {
    if (streak >= 2) {
      chip.style.display = 'flex';
      chip.querySelector('.streak-count').textContent = `${streak} day streak`;
    } else {
      chip.style.display = 'none';
    }
  }

  // Render recently played on load
  EngagementEngine._renderRecentBar();

  // Expose globals for inline event handlers
  window.Router = Router;
}

document.addEventListener('DOMContentLoaded', boot);
