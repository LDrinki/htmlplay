/**
 * HTMLplay Engagement System
 *
 * 8 systems, all localStorage-backed, zero backend:
 * 1. Recently Played Bar     — last 12 games, persisted
 * 2. Daily Streak            — tracks consecutive daily visits
 * 3. Achievement System      — milestone unlock toasts
 * 4. Game Completion Tracker — per-game session flags
 * 5. Smart Recommendations   — tag + category overlap scoring
 * 6. Play Next Instantly     — preloads top recommendation
 * 7. Category Progress       — badges for playing in each category
 * 8. Auto Preview on Hover  — muted iframe preview
 */

class EngagementEngine {
  constructor() {
    this._state = this._loadState();
    this._checkStreak();
    this._achievementQueue = [];
    this._processingToast = false;
  }

  /* ── STATE PERSISTENCE ─────────────────────────────────── */
  _loadState() {
    try {
      return JSON.parse(localStorage.getItem('hp-engagement') || '{}');
    } catch { return {}; }
  }

  _saveState() {
    try { localStorage.setItem('hp-engagement', JSON.stringify(this._state)); }
    catch {}
  }

  /* ── 1. RECENTLY PLAYED ────────────────────────────────── */
  trackPlay(game) {
    if (!this._state.recentlyPlayed) this._state.recentlyPlayed = [];
    // Remove if already exists (dedup)
    this._state.recentlyPlayed = this._state.recentlyPlayed.filter(g => g.slug !== game.slug);
    this._state.recentlyPlayed.unshift({
      slug: game.slug, title: game.title, thumbnail: game.thumbnail,
      category: game.category, playedAt: Date.now()
    });
    // Cap at 12
    this._state.recentlyPlayed = this._state.recentlyPlayed.slice(0, 12);

    // Track total plays for achievements
    this._state.totalPlays = (this._state.totalPlays || 0) + 1;
    this._checkAchievements();

    // Track category progression
    this._trackCategory(game.category);

    this._saveState();
    this._renderRecentBar();
  }

  _renderRecentBar() {
    const bar = document.getElementById('recently-played');
    const scroll = document.getElementById('recent-scroll');
    if (!scroll) return;

    const items = this._state.recentlyPlayed || [];
    if (!items.length) { bar?.classList.add('hidden'); return; }
    bar?.classList.remove('hidden');

    scroll.innerHTML = items.map(g => `
      <a href="/game/${g.slug}" class="recent-chip" title="${g.title}">
        <img src="${g.thumbnail}" alt="${g.title}" loading="lazy" width="28" height="28">
        <span>${g.title}</span>
      </a>
    `).join('');
  }

  getRecentlyPlayed() { return this._state.recentlyPlayed || []; }

  /* ── 2. DAILY STREAK ───────────────────────────────────── */
  _checkStreak() {
    const now   = Date.now();
    const lastVisit = this._state.lastVisit || 0;
    const dayMs = 86400000;
    const daysSince = Math.floor((now - lastVisit) / dayMs);

    if (daysSince === 0) {
      // Same day, no change
    } else if (daysSince === 1) {
      // Consecutive day
      this._state.streak = (this._state.streak || 0) + 1;
    } else {
      // Streak broken
      this._state.streak = 1;
    }

    this._state.lastVisit = now;
    this._saveState();
    this._renderStreakChip();
  }

  _renderStreakChip() {
    const chip = document.getElementById('streak-chip');
    if (!chip) return;
    const s = this._state.streak || 0;
    if (s < 2) { chip.style.display = 'none'; return; }
    chip.style.display = 'flex';
    chip.querySelector('.streak-count').textContent = `${s} day streak`;
  }

  getStreak() { return this._state.streak || 0; }

  /* ── 3. ACHIEVEMENTS ───────────────────────────────────── */
  _ACHIEVEMENTS = [
    { id: 'first_game',  icon: '🎮', name: 'First Play!',      desc: 'You played your first game.',     check: s => s.totalPlays >= 1         },
    { id: 'game_5',      icon: '🔥', name: 'On a Roll',         desc: 'Played 5 different games.',       check: s => s.totalPlays >= 5         },
    { id: 'game_10',     icon: '⚡', name: 'Power Gamer',       desc: 'Played 10 games.',                check: s => s.totalPlays >= 10        },
    { id: 'game_25',     icon: '🏆', name: 'Arcade Champion',   desc: '25 games played.',                check: s => s.totalPlays >= 25        },
    { id: 'game_50',     icon: '💎', name: 'Legendary',         desc: '50 games played.',                check: s => s.totalPlays >= 50        },
    { id: 'streak_3',    icon: '📅', name: '3-Day Streak',      desc: 'Visited 3 days in a row.',        check: s => (s.streak || 0) >= 3      },
    { id: 'streak_7',    icon: '🌟', name: 'Weekly Warrior',    desc: '7-day streak. Incredible.',       check: s => (s.streak || 0) >= 7      },
    { id: 'categories',  icon: '🗺️', name: 'Explorer',          desc: 'Played games in 5 categories.',  check: s => Object.keys(s.categories || {}).length >= 5 },
    { id: 'horror',      icon: '💀', name: 'Fearless',          desc: 'Played a horror game.',           check: s => !!(s.categories?.horror)  },
  ];

  _checkAchievements() {
    if (!this._state.achievements) this._state.achievements = {};
    for (const ach of this._ACHIEVEMENTS) {
      if (!this._state.achievements[ach.id] && ach.check(this._state)) {
        this._state.achievements[ach.id] = Date.now();
        this._queueToast(ach);
      }
    }
  }

  _queueToast(achievement) {
    this._achievementQueue.push(achievement);
    if (!this._processingToast) this._processToastQueue();
  }

  async _processToastQueue() {
    this._processingToast = true;
    while (this._achievementQueue.length) {
      const ach = this._achievementQueue.shift();
      await this._showToast(ach);
      await this._sleep(600);
    }
    this._processingToast = false;
  }

  _showToast(ach) {
    return new Promise(resolve => {
      const toast = document.getElementById('achievement-toast');
      if (!toast) return resolve();

      toast.querySelector('.toast-icon').textContent = ach.icon;
      toast.querySelector('.toast-name').textContent = ach.name;
      toast.querySelector('.toast-desc').textContent = ach.desc;

      toast.classList.add('show');
      setTimeout(() => { toast.classList.remove('show'); setTimeout(resolve, 400); }, 3500);
    });
  }

  /* ── 4. GAME COMPLETION TRACKER ────────────────────────── */
  markSession(slug, durationSeconds) {
    if (!this._state.sessions) this._state.sessions = {};
    if (!this._state.sessions[slug]) this._state.sessions[slug] = { count: 0, totalTime: 0 };
    this._state.sessions[slug].count++;
    this._state.sessions[slug].totalTime += durationSeconds;
    this._state.sessions[slug].lastPlayed = Date.now();
    this._saveState();
  }

  getSessionInfo(slug) { return this._state.sessions?.[slug] || null; }

  /* ── 5. SMART RECOMMENDATIONS ───────────────────────────── */
  /**
   * Algorithm:
   * Score = categoryMatch(40) + tagOverlap(10 per tag) + mobileMatch(5) - recentlyPlayedPenalty(20)
   * Returns top-N games sorted by score.
   */
  async getRecommendations(currentGame, allGames, limit = 6) {
    const recentSlugs = new Set((this._state.recentlyPlayed || []).map(g => g.slug));
    const playedCats  = Object.keys(this._state.categories || {});

    return allGames
      .filter(g => g.slug !== currentGame.slug)
      .map(g => {
        let score = 0;
        if (g.category === currentGame.category) score += 40;
        if (g.subCategory === currentGame.subCategory) score += 20;
        const tagOverlap = (g.tags || []).filter(t => (currentGame.tags || []).includes(t)).length;
        score += tagOverlap * 10;
        if (g.mobileCompatible === currentGame.mobileCompatible) score += 5;
        if (recentSlugs.has(g.slug)) score -= 20;  // Diversity penalty
        if (playedCats.includes(g.category)) score += 8; // User affinity
        score += Math.log10((g.trendingScore || 0) + 1);
        return { game: g, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.game);
  }

  /* ── 6. PLAY NEXT INSTANTLY ─────────────────────────────── */
  /**
   * After a game loads, preconnect to the top recommendation's origin.
   * When user finishes, iframe src swaps instantly (already in browser cache).
   */
  async preloadNext(recommendedGame) {
    if (!recommendedGame?.gameUrl) return;

    // Preconnect to game's origin
    let link = document.head.querySelector('link[rel="preload"][data-next]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'prefetch';
      link.dataset.next = '1';
      document.head.appendChild(link);
    }
    link.href = recommendedGame.gameUrl;
  }

  /* ── 7. CATEGORY PROGRESSION ────────────────────────────── */
  _trackCategory(category) {
    if (!this._state.categories) this._state.categories = {};
    this._state.categories[category] = (this._state.categories[category] || 0) + 1;
  }

  getCategoryProgress() {
    const cats = this._state.categories || {};
    return Object.entries(cats).map(([cat, count]) => ({ category: cat, count }));
  }

  /**
   * Badge levels: Bronze(1) → Silver(5) → Gold(10) → Platinum(25)
   */
  getCategoryBadge(category) {
    const count = this._state.categories?.[category] || 0;
    if (count >= 25) return { level: 'platinum', icon: '💎', color: '#00e5ff' };
    if (count >= 10) return { level: 'gold',     icon: '🥇', color: '#ffcc00' };
    if (count >= 5)  return { level: 'silver',   icon: '🥈', color: '#c0c0c0' };
    if (count >= 1)  return { level: 'bronze',   icon: '🥉', color: '#cd7f32' };
    return null;
  }

  /* ── 8. AUTO PREVIEW ON HOVER ────────────────────────────── */
  /**
   * On card hover (desktop, >500ms dwell):
   * - Show muted thumbnail animation (CSS only, zero cost)
   * - For cards with data-preview-url: inject tiny muted iframe
   * Performance: max 1 preview iframe at a time, destroyed on mouseout.
   */
  bindHoverPreviews() {
    let hoverTimer = null;
    let activePreview = null;

    document.addEventListener('mouseover', e => {
      const card = e.target.closest('.game-card[data-preview-url]');
      if (!card) return;

      hoverTimer = setTimeout(() => {
        const prev = card.querySelector('.card-preview');
        if (!prev) return;

        // Destroy previous preview
        activePreview?.remove();

        // Create muted iframe preview
        const iframe = document.createElement('iframe');
        iframe.src = card.dataset.previewUrl;
        iframe.style.cssText = 'width:100%;height:100%;border:none;pointer-events:none';
        iframe.allow = 'autoplay';
        iframe.setAttribute('muted', '');

        // Inject into preview zone
        prev.innerHTML = '';
        prev.appendChild(iframe);
        activePreview = iframe;
      }, 600);
    });

    document.addEventListener('mouseout', e => {
      const card = e.target.closest('.game-card[data-preview-url]');
      if (!card) return;
      clearTimeout(hoverTimer);
      // Restore play button
      const prev = card.querySelector('.card-preview');
      if (prev && activePreview?.parentNode === prev) {
        prev.innerHTML = '<div class="card-play-btn">▶</div>';
        activePreview = null;
      }
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

window.EngagementEngine = new EngagementEngine();
export default window.EngagementEngine;
