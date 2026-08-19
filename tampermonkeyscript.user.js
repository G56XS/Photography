// ==UserScript==
// @name         UnLikeIt
// @version      2.0.0
// @description  Take back your privacy. Wipe Instagram history, manage followers, and download media. No complex dev scripts needed.
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      instagram.com
// @connect      cdninstagram.com
// @connect      fbcdn.net
// @connect      scontent.cdninstagram.com
// ==/UserScript==

(function () {
    'use strict';

    // ─────────────────────────────────────────────
    // GLOBAL CONFIG
    // ─────────────────────────────────────────────
    const CONFIG = {
        virtualRoute: '/unlikeit',
        cleanerRoutes: ['/your_activity/interactions/likes', '/your_activity/interactions/comments'],
        version: '2.0.0'
    };

    // ─────────────────────────────────────────────
    // UTILITIES
    // ─────────────────────────────────────────────
    function getCookie(name) {
        const v = `; ${document.cookie}`;
        const parts = v.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    function getCsrf() { return getCookie('csrftoken') || ''; }
    function getUserId() { return getCookie('ds_user_id') || null; }

    async function igFetch(url, opts = {}) {
        const csrf = getCsrf();
        const defaults = {
            headers: {
                'x-csrftoken': csrf,
                'x-ig-app-id': '936619743392459',
                'x-requested-with': 'XMLHttpRequest',
                'accept': '*/*',
            }
        };
        const merged = { ...defaults, ...opts, headers: { ...defaults.headers, ...(opts.headers || {}) } };
        return fetch(url, merged);
    }

    function blobDownload(url, filename) {
        return new Promise((resolve, reject) => {
            // Try GM_xmlhttpRequest for cross-origin media first
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    responseType: 'blob',
                    headers: { 'referer': 'https://www.instagram.com/' },
                    onload(r) {
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(r.response);
                        a.download = filename;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                        resolve(true);
                    },
                    onerror: reject
                });
            } else {
                // Fallback: open in new tab — user saves manually
                window.open(url, '_blank');
                resolve(false);
            }
        });
    }

    function sanitize(str) {
        return (str || 'unknown').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 60);
    }

    function exportCSV(rows, filename) {
        const header = Object.keys(rows[0]).join(',');
        const body = rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    // ─────────────────────────────────────────────
    // SHARED CSS TOKENS
    // ─────────────────────────────────────────────
    const SHARED_CSS = `
        :root {
            --app-font: 'Helvetica Neue', Helvetica, Arial, sans-serif;
            --bg-root: #0f0f12;
            --glass-base: rgba(30, 30, 35, 0.65);
            --glass-card: rgba(255, 255, 255, 0.03);
            --glass-card-hover: rgba(255, 255, 255, 0.07);
            --glass-border: rgba(255, 255, 255, 0.08);
            --glass-highlight: rgba(255, 255, 255, 0.15);
            --text-primary: #F5F5F7;
            --text-secondary: #86868B;
            --text-tertiary: #58585D;
            --accent-blue: #2997FF;
            --accent-lilac: #AF52DE;
            --accent-cyan: #5AC8FA;
            --accent-danger: #FF453A;
            --accent-success: #30D158;
            --accent-orange: #FF9F0A;
            --gradient-mesh: radial-gradient(circle at 0% 0%, rgba(41,151,255,0.08), transparent 40%),
                             radial-gradient(circle at 100% 100%, rgba(175,82,222,0.08), transparent 40%);
        }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
    `;

    // ─────────────────────────────────────────────
    // INSTAGRAM REST API WRAPPER (v2 — no query_hash)
    // ─────────────────────────────────────────────
    const InstagramAPI = {
        // Fetch following or followers using the web REST API
        async fetchRelation(userId, type, progressCb) {
            const endpoint = type === 'following'
                ? `https://www.instagram.com/api/v1/friendships/${userId}/following/`
                : `https://www.instagram.com/api/v1/friendships/${userId}/followers/`;
            let users = [], maxId = null, hasMore = true;

            while (hasMore) {
                const url = maxId ? `${endpoint}?max_id=${maxId}&count=50` : `${endpoint}?count=50`;
                try {
                    const r = await igFetch(url);
                    if (r.status === 429) throw new Error('RATE_LIMIT');
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const json = await r.json();
                    const items = json.users || [];
                    users.push(...items);
                    hasMore = !!json.next_max_id;
                    maxId = json.next_max_id || null;
                    if (progressCb) progressCb(users.length);
                    if (hasMore) await sleep(700 + Math.random() * 600);
                } catch (e) {
                    if (e.message === 'RATE_LIMIT') throw e;
                    console.warn('[UnLikeIt] fetchRelation error:', e);
                    hasMore = false;
                }
            }
            return users;
        },

        async unfollow(userId) {
            try {
                const r = await igFetch(`https://www.instagram.com/api/v1/friendships/destroy/${userId}/`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: `user_id=${userId}`
                });
                return r.ok;
            } catch { return false; }
        },

        async getUserInfo(username) {
            try {
                const r = await igFetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`);
                if (!r.ok) return null;
                const json = await r.json();
                return json.data?.user || null;
            } catch { return null; }
        },

        // Get all posts for a user with full pagination + live progress callback
        async getUserPosts(userId, progressCb = null) {
            let allPosts = [], nextMaxId = null, hasMore = true;
            while (hasMore) {
                try {
                    const url = nextMaxId
                        ? `https://www.instagram.com/api/v1/feed/user/${userId}/?count=12&max_id=${nextMaxId}`
                        : `https://www.instagram.com/api/v1/feed/user/${userId}/?count=12`;
                    const r = await igFetch(url);
                    if (r.status === 429) { console.warn('[UnLikeIt] rate limit on posts'); break; }
                    if (!r.ok) break;
                    const json = await r.json();
                    const items = json.items || [];
                    allPosts.push(...items);
                    if (progressCb) progressCb(allPosts.length);
                    hasMore = json.more_available === true && !!json.next_max_id;
                    nextMaxId = json.next_max_id || null;
                    if (hasMore) await sleep(600 + Math.random() * 400);
                } catch { break; }
            }
            return allPosts;
        },

        // Get active stories for a user
        async getUserStories(userId) {
            try {
                const r = await igFetch(`https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`);
                if (!r.ok) return [];
                const json = await r.json();
                const reel = json.reels?.[userId] || json.reels_media?.[0];
                return reel?.items || [];
            } catch { return []; }
        },

        // Search for users
        async searchUsers(query) {
            try {
                const r = await igFetch(`https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(query)}&include_reel=false`);
                if (!r.ok) return [];
                const json = await r.json();
                return (json.users || []).map(u => u.user);
            } catch { return []; }
        }
    };

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ─────────────────────────────────────────────
    // MEDIA DOWNLOADER MODULE
    // ─────────────────────────────────────────────
    const MediaDownloader = {
        async start(preloadUser = null) {
            document.title = 'UnLikeIt — Media Downloader';
            const style = document.createElement('style');
            style.textContent = SHARED_CSS + `
                body {
                    background: var(--bg-root);
                    background-image: var(--gradient-mesh);
                    color: var(--text-primary);
                    font-family: var(--app-font);
                    margin: 0; height: 100vh;
                    display: flex; overflow: hidden;
                }
                .sidebar {
                    width: 300px;
                    background: rgba(20,20,24,0.8);
                    backdrop-filter: blur(40px) saturate(180%);
                    border-right: 1px solid var(--glass-border);
                    padding: 44px 24px;
                    display: flex; flex-direction: column;
                    z-index: 20;
                }
                .logo-main { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; color: var(--text-primary); margin-bottom: 4px; }
                .logo-sub { font-size: 13px; color: var(--text-secondary); }
                .search-wrap { position: relative; margin: 32px 0 8px; }
                .search-wrap input {
                    width: 100%; background: rgba(255,255,255,0.06);
                    border: 1px solid var(--glass-border); border-radius: 12px;
                    color: var(--text-primary); padding: 12px 16px; font-size: 14px;
                    outline: none; transition: 0.2s; font-family: var(--app-font);
                }
                .search-wrap input:focus { border-color: var(--accent-blue); background: rgba(255,255,255,0.09); }
                .search-wrap input::placeholder { color: var(--text-tertiary); }
                .search-results { background: rgba(20,20,25,0.98); border: 1px solid var(--glass-border); border-radius: 12px; overflow: hidden; }
                .search-result-item {
                    padding: 10px 14px; cursor: pointer; display: flex; align-items: center; gap: 10px;
                    transition: 0.15s; font-size: 13px; color: var(--text-primary);
                }
                .search-result-item:hover { background: rgba(255,255,255,0.06); }
                .search-result-item img { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
                .profile-card {
                    margin-top: 20px; background: var(--glass-card);
                    border: 1px solid var(--glass-border); border-radius: 16px; padding: 20px; text-align: center;
                }
                .profile-card img { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; margin-bottom: 10px; border: 1px solid var(--glass-border); }
                .profile-card .username { font-weight: 700; font-size: 15px; }
                .profile-card .name { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
                .profile-stats { display: flex; justify-content: space-around; margin-top: 14px; }
                .profile-stats span { text-align: center; }
                .profile-stats strong { display: block; font-size: 16px; font-weight: 700; }
                .profile-stats small { font-size: 11px; color: var(--text-secondary); }
                .tab-bar {
                    display: flex; border-bottom: 1px solid var(--glass-border); margin-bottom: 32px;
                }
                .tab {
                    flex: 1; padding: 14px 8px; text-align: center; cursor: pointer;
                    font-size: 13px; font-weight: 500; color: var(--text-secondary);
                    border-bottom: 2px solid transparent; transition: 0.2s;
                }
                .tab.active { color: var(--text-primary); border-bottom-color: var(--text-primary); }
                .main-content { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
                .header-bar {
                    padding: 24px 40px; background: rgba(15,15,18,0.7);
                    backdrop-filter: blur(25px); border-bottom: 1px solid var(--glass-border);
                    position: sticky; top: 0; z-index: 10;
                    display: flex; justify-content: space-between; align-items: center;
                }
                h3 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.02em; }
                .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; padding: 32px 40px; }
                .media-thumb {
                    border-radius: 14px; overflow: hidden; position: relative;
                    background: var(--glass-card); border: 1px solid var(--glass-border);
                    aspect-ratio: 1; cursor: pointer; transition: 0.3s;
                }
                .media-thumb:hover { transform: scale(1.02); border-color: var(--glass-highlight); }
                .media-thumb img, .media-thumb video {
                    width: 100%; height: 100%; object-fit: cover; display: block;
                }
                .media-thumb .overlay {
                    position: absolute; inset: 0; background: rgba(0,0,0,0); display: flex;
                    align-items: center; justify-content: center; gap: 10px;
                    transition: 0.25s; opacity: 0;
                }
                .media-thumb:hover .overlay { background: rgba(0,0,0,0.55); opacity: 1; }
                .media-badge {
                    position: absolute; top: 10px; right: 10px;
                    background: rgba(0,0,0,0.7); border-radius: 6px; padding: 3px 7px;
                    font-size: 10px; color: #fff; font-weight: 600; letter-spacing: 0.04em;
                }
                .story-badge { background: rgba(255, 159, 10, 0.85); }
                .dl-btn {
                    background: rgba(255,255,255,0.15); backdrop-filter: blur(10px);
                    border: 1px solid rgba(255,255,255,0.25); border-radius: 8px;
                    padding: 8px 14px; color: #fff; font-size: 12px; font-weight: 600;
                    cursor: pointer; transition: 0.15s; font-family: var(--app-font);
                }
                .dl-btn:hover { background: rgba(255,255,255,0.3); }
                .empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-secondary); gap: 12px; }
                .empty-state .icon { font-size: 48px; opacity: 0.3; }
                .empty-state p { font-size: 15px; font-weight: 400; }
                .btn-action {
                    background: var(--text-primary); color: #000; border: none; border-radius: 10px;
                    padding: 10px 20px; font-weight: 600; font-size: 13px; cursor: pointer;
                    transition: 0.2s; font-family: var(--app-font);
                }
                .btn-action:hover { opacity: 0.85; }
                .btn-action.secondary { background: rgba(255,255,255,0.08); color: var(--text-primary); }
                .loading-spinner {
                    width: 32px; height: 32px; border: 2px solid rgba(255,255,255,0.1);
                    border-top-color: var(--text-primary); border-radius: 50%; animation: spin 0.7s linear infinite;
                }
                @keyframes spin { to { transform: rotate(360deg); } }
                .toast {
                    position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
                    background: rgba(40,40,45,0.95); backdrop-filter: blur(20px);
                    border: 1px solid var(--glass-border); border-radius: 12px;
                    padding: 12px 24px; font-size: 13px; font-weight: 500; color: var(--text-primary);
                    z-index: 999999; transition: opacity 0.3s; pointer-events: none;
                }
                .pfp-section { padding: 0 40px 40px; display: flex; align-items: center; gap: 24px; }
                .pfp-large { width: 120px; height: 120px; border-radius: 50%; object-fit: cover; border: 1px solid var(--glass-border); flex-shrink: 0; }
                .pfp-info h4 { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
                .pfp-info p { color: var(--text-secondary); font-size: 14px; margin: 0 0 16px; }
                ::-webkit-scrollbar { width: 6px; }
                ::-webkit-scrollbar-track { background: transparent; }
                ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
            `;
            document.head.appendChild(style);

            document.body.innerHTML = `
                <div class="sidebar">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px">
                        <div class="logo-main">UnLikeIt</div>
                        <button id="btn-exit-media" title="Back to Instagram" style="background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.1); border-radius:8px; color:var(--text-secondary); font-size:13px; font-weight:600; cursor:pointer; padding:6px 12px; font-family:var(--app-font); transition:0.15s; white-space:nowrap">✕ Exit</button>
                    </div>
                    <div class="logo-sub">Media Downloader v${CONFIG.version}</div>

                    <div class="search-wrap">
                        <input id="user-search" placeholder="Search Instagram user..." autocomplete="off">
                    </div>
                    <div id="search-results" class="search-results" style="display:none"></div>
                    <div id="profile-card" style="display:none" class="profile-card"></div>

                    <div style="margin-top:auto; font-size:12px; color:var(--text-tertiary); line-height:1.6">
                        ⚠️ Stories disappear after 24h. Media is downloaded via your browser session.
                    </div>
                </div>
                <div class="main-content">
                    <div class="header-bar">
                        <h3 id="main-title">Media Downloader</h3>
                        <div style="display:flex; gap:10px" id="header-actions"></div>
                    </div>
                    <div id="tab-bar" style="display:none; padding: 0 40px;" class="tab-bar">
                        <div class="tab active" data-tab="posts">Posts</div>
                        <div class="tab" data-tab="stories">Stories</div>
                        <div class="tab" data-tab="pfp">Profile Pic</div>
                    </div>
                    <div id="content-area" style="flex:1">
                        <div class="empty-state">
                            <div class="icon">🔍</div>
                            <p>Search for a user to browse their public media</p>
                        </div>
                    </div>
                </div>
            `;

            const self = this;
            let currentUser = null;
            let searchTimer = null;

            const searchInput = document.getElementById('user-search');
            const searchResults = document.getElementById('search-results');

            // Exit / close handlers
            document.getElementById('btn-exit-media').onclick = () => { window.location.href = '/'; };
            document.addEventListener('keydown', e => { if (e.key === 'Escape') window.location.href = '/'; }, { once: true });

            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimer);
                const q = e.target.value.trim();
                if (q.length < 2) { searchResults.style.display = 'none'; return; }
                searchTimer = setTimeout(async () => {
                    const users = await InstagramAPI.searchUsers(q);
                    if (!users.length) { searchResults.style.display = 'none'; return; }
                    searchResults.innerHTML = users.slice(0, 6).map(u => `
                        <div class="search-result-item" data-username="${u.username}">
                            <img src="${u.profile_pic_url}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22><circle cx=%2216%22 cy=%2216%22 r=%2216%22 fill=%22%23333%22/></svg>'">
                            <div>
                                <div style="font-weight:600">${u.username}</div>
                                <div style="font-size:11px; color:var(--text-secondary)">${u.full_name || ''}</div>
                            </div>
                        </div>
                    `).join('');
                    searchResults.style.display = 'block';
                    searchResults.querySelectorAll('.search-result-item').forEach(el => {
                        el.onclick = () => { loadUser(el.dataset.username); searchResults.style.display = 'none'; searchInput.value = el.dataset.username; };
                    });
                }, 400);
            });

            async function loadUser(username) {
                const profileCard = document.getElementById('profile-card');
                const tabBar = document.getElementById('tab-bar');
                profileCard.style.display = 'none';
                tabBar.style.display = 'none';
                showContent('<div class="empty-state"><div class="loading-spinner"></div><p>Loading profile...</p></div>');

                const user = await InstagramAPI.getUserInfo(username);
                if (!user) {
                    showContent('<div class="empty-state"><div class="icon">⚠️</div><p>Profile not found or is private.</p></div>');
                    return;
                }
                currentUser = user;

                const picUrl = user.profile_pic_url_hd || user.profile_pic_url;
                profileCard.innerHTML = `
                    <img src="${picUrl}" onerror="this.style.visibility='hidden'">
                    <div class="username">@${user.username}</div>
                    <div class="name">${user.full_name || ''}</div>
                    <div class="profile-stats">
                        <span><strong>${fmtNum(user.edge_owner_to_timeline_media?.count || 0)}</strong><small>Posts</small></span>
                        <span><strong>${fmtNum(user.edge_followed_by?.count || 0)}</strong><small>Followers</small></span>
                        <span><strong>${fmtNum(user.edge_follow?.count || 0)}</strong><small>Following</small></span>
                    </div>
                `;
                profileCard.style.display = 'block';
                tabBar.style.display = 'flex';

                // Activate tabs
                document.querySelectorAll('.tab').forEach(t => {
                    t.onclick = () => {
                        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
                        t.classList.add('active');
                        self.switchTab(t.dataset.tab, currentUser);
                    };
                });

                // Default: load posts
                document.querySelector('[data-tab="posts"]').classList.add('active');
                self.switchTab('posts', currentUser);
            }

            if (preloadUser) {
                searchInput.value = preloadUser;
                loadUser(preloadUser);
            }
        },

        fmtNum(n) {
            if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
            if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
            return String(n);
        },

        async switchTab(tab, user) {
            if (tab === 'posts') await this.renderPosts(user);
            if (tab === 'stories') await this.renderStories(user);
            if (tab === 'pfp') await this.renderPFP(user);
        },

        async renderPosts(user) {
            if (user.is_private) {
                showContent('<div class="empty-state"><div class="icon">🔒</div><p>This account is private.</p></div>');
                return;
            }
            document.getElementById('main-title').textContent = `Posts — @${user.username}`;
            document.getElementById('header-actions').innerHTML = '';

            // Show live-updating loading state
            showContent(`
                <div class="empty-state">
                    <div class="loading-spinner"></div>
                    <p>Loading posts... <span id="post-load-count" style="color:var(--accent-blue);font-variant-numeric:tabular-nums">0</span> fetched</p>
                    <p style="font-size:12px;color:var(--text-tertiary);margin-top:-4px">Paginating through all ${fmtNum(user.edge_owner_to_timeline_media?.count || 0)} posts</p>
                </div>
            `);

            const posts = await InstagramAPI.getUserPosts(user.pk || user.id, (n) => {
                const el = document.getElementById('post-load-count');
                if (el) el.textContent = n;
            });

            if (!posts.length) {
                showContent('<div class="empty-state"><div class="icon">📭</div><p>No posts found.</p></div>');
                return;
            }

            const headerActions = document.getElementById('header-actions');
            headerActions.innerHTML = `
                <button class="btn-action secondary" id="dl-all-posts">⬇ Download All (${posts.length})</button>
            `;

            let html = '<div class="media-grid">';
            posts.forEach((post, i) => {
                const isVideo = post.media_type === 2;
                const isCarousel = post.media_type === 8;
                const thumb = post.image_versions2?.candidates?.[0]?.url || post.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url || '';
                const badge = isVideo ? 'VIDEO' : isCarousel ? `+${post.carousel_media?.length || 0}` : '';
                html += `
                    <div class="media-thumb" data-index="${i}">
                        <img src="${thumb}" loading="lazy" onerror="this.parentElement.style.background='#1a1a1a'">
                        ${badge ? `<div class="media-badge">${badge}</div>` : ''}
                        <div class="overlay">
                            <button class="dl-btn" data-idx="${i}" data-type="${isVideo ? 'video' : isCarousel ? 'carousel' : 'photo'}">⬇ Save</button>
                            ${isCarousel ? `<button class="dl-btn" data-idx="${i}" data-type="all">All ${post.carousel_media?.length}</button>` : ''}
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            showContent(html);

            document.querySelectorAll('.dl-btn').forEach(btn => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.dataset.idx);
                    const type = btn.dataset.type;
                    const post = posts[idx];
                    btn.textContent = '...';
                    try {
                        await this.downloadPost(post, user.username, type === 'all');
                        btn.textContent = '✓';
                    } catch { btn.textContent = '✗'; }
                };
            });

            document.getElementById('dl-all-posts').onclick = async () => {
                const btn = document.getElementById('dl-all-posts');
                btn.textContent = 'Downloading...';
                btn.disabled = true;
                for (let i = 0; i < posts.length; i++) {
                    btn.textContent = `Downloading ${i + 1}/${posts.length}...`;
                    await this.downloadPost(posts[i], user.username, true);
                    await sleep(400);
                }
                btn.textContent = '✓ Done';
            };
        },

        async downloadPost(post, username, allItems = false) {
            const prefix = sanitize(username);
            const code = post.code || post.id;
            const isVideo = post.media_type === 2;
            const isCarousel = post.media_type === 8;

            if (isCarousel && allItems) {
                const items = post.carousel_media || [];
                for (let i = 0; i < items.length; i++) {
                    const m = items[i];
                    const isVid = m.media_type === 2;
                    const url = isVid ? m.video_versions?.[0]?.url : m.image_versions2?.candidates?.[0]?.url;
                    if (url) await blobDownload(url, `${prefix}_${code}_${i + 1}.${isVid ? 'mp4' : 'jpg'}`);
                    await sleep(300);
                }
            } else if (isVideo) {
                const url = post.video_versions?.[0]?.url;
                if (url) await blobDownload(url, `${prefix}_${code}.mp4`);
            } else {
                const url = post.image_versions2?.candidates?.[0]?.url;
                if (url) await blobDownload(url, `${prefix}_${code}.jpg`);
            }
        },

        async renderStories(user) {
            showContent('<div class="empty-state"><div class="loading-spinner"></div><p>Fetching stories...</p></div>');
            document.getElementById('main-title').textContent = `Stories — @${user.username}`;

            const stories = await InstagramAPI.getUserStories(user.pk || user.id);
            if (!stories.length) {
                showContent('<div class="empty-state"><div class="icon">👁️</div><p>No active stories — or this account is private.</p></div>');
                return;
            }

            const headerActions = document.getElementById('header-actions');
            headerActions.innerHTML = `<button class="btn-action secondary" id="dl-all-stories">⬇ Save All (${stories.length})</button>`;

            // Stories use a card layout with always-visible button (not hover-only)
            // because the hover overlay was unreliable on story thumbnails
            let html = '<div class="media-grid">';
            stories.forEach((item, i) => {
                const isVideo = item.media_type === 2;
                const thumb = item.image_versions2?.candidates?.[0]?.url || '';
                const timeLeft = item.expiring_at
                    ? Math.max(0, Math.round((item.expiring_at * 1000 - Date.now()) / 3600000))
                    : null;
                html += `
                    <div class="media-thumb" style="aspect-ratio:9/16; border-radius:14px; overflow:hidden; position:relative; background:var(--glass-card); border:1px solid var(--glass-border);">
                        <img src="${thumb}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">
                        <div style="position:absolute;top:8px;left:8px;background:rgba(255,159,10,0.85);border-radius:6px;padding:3px 8px;font-size:10px;color:#fff;font-weight:700;">
                            ${isVideo ? '🎬 VIDEO' : '📸 PHOTO'} ${timeLeft !== null ? `· ${timeLeft}h left` : ''}
                        </div>
                        <div style="position:absolute;bottom:0;left:0;right:0;padding:28px 12px 12px;background:linear-gradient(transparent,rgba(0,0,0,0.75));">
                            <button class="dl-btn story-dl-btn" data-idx="${i}" style="width:100%;text-align:center;padding:8px;">⬇ Save Story</button>
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            showContent(html);

            document.querySelectorAll('.story-dl-btn').forEach(btn => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.dataset.idx);
                    const item = stories[idx];
                    const origText = btn.textContent;
                    btn.textContent = '⏳ Saving...';
                    btn.disabled = true;
                    try {
                        await this.downloadStoryItem(item, user.username, idx);
                        btn.textContent = '✓ Saved!';
                        btn.style.background = 'rgba(48,209,88,0.3)';
                    } catch {
                        btn.textContent = '✗ Failed';
                        btn.disabled = false;
                    }
                };
            });

            document.getElementById('dl-all-stories').onclick = async () => {
                const btn = document.getElementById('dl-all-stories');
                btn.disabled = true;
                for (let i = 0; i < stories.length; i++) {
                    btn.textContent = `Saving ${i + 1}/${stories.length}...`;
                    await this.downloadStoryItem(stories[i], user.username, i);
                    // Update the individual button too
                    const indBtn = document.querySelector(`.story-dl-btn[data-idx="${i}"]`);
                    if (indBtn) { indBtn.textContent = '✓ Saved!'; indBtn.style.background = 'rgba(48,209,88,0.3)'; }
                    await sleep(300);
                }
                btn.textContent = '✓ All Done';
            };
        },

        async downloadStoryItem(item, username, idx) {
            const prefix = sanitize(username);
            const isVideo = item.media_type === 2;
            const url = isVideo ? item.video_versions?.[0]?.url : item.image_versions2?.candidates?.[0]?.url;
            if (url) await blobDownload(url, `${prefix}_story_${idx + 1}.${isVideo ? 'mp4' : 'jpg'}`);
        },

        async renderPFP(user) {
            document.getElementById('main-title').textContent = `Profile Picture — @${user.username}`;
            document.getElementById('header-actions').innerHTML = '';
            const hdUrl = user.profile_pic_url_hd || user.profile_pic_url;
            const html = `
                <div style="padding: 40px">
                    <div class="pfp-section">
                        <img class="pfp-large" src="${hdUrl}">
                        <div class="pfp-info">
                            <h4>@${user.username}</h4>
                            <p>${user.full_name || ''}</p>
                            <div style="display:flex; gap:10px">
                                <button class="btn-action" id="dl-pfp">⬇ Download HD</button>
                                <a href="${hdUrl}" target="_blank" class="btn-action secondary" style="text-decoration:none; display:inline-flex; align-items:center">Open Full Size</a>
                            </div>
                        </div>
                    </div>
                    <div style="margin-top: 24px; padding: 20px; background: var(--glass-card); border: 1px solid var(--glass-border); border-radius: 14px; font-size: 13px; color: var(--text-secondary); line-height: 1.6;">
                        💡 <strong style="color:var(--text-primary)">Tip:</strong> Instagram serves the highest-resolution profile picture available. Private accounts may serve a lower-res version to non-followers.
                    </div>
                </div>
            `;
            showContent(html);
            document.getElementById('dl-pfp').onclick = async () => {
                const btn = document.getElementById('dl-pfp');
                btn.textContent = 'Downloading...';
                await blobDownload(hdUrl, `${sanitize(user.username)}_pfp.jpg`);
                btn.textContent = '✓ Saved';
            };
        }
    };

    function showContent(html) {
        const area = document.getElementById('content-area');
        if (area) area.innerHTML = html;
    }

    function fmtNum(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }

    function showToast(msg, duration = 2500) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
    }

    // ─────────────────────────────────────────────
    // RELATION MANAGER MODULE (v2)
    // ─────────────────────────────────────────────
    const RelationManager = {
        start() {
            document.title = 'UnLikeIt — Relation Manager';
            const style = document.createElement('style');
            style.textContent = SHARED_CSS + `
                body {
                    background: var(--bg-root);
                    background-image: var(--gradient-mesh);
                    color: var(--text-primary);
                    font-family: var(--app-font);
                    margin: 0; height: 100vh;
                    display: flex; overflow: hidden;
                    letter-spacing: -0.01em;
                }
                .sidebar {
                    width: 300px; background: rgba(20,20,24,0.8);
                    backdrop-filter: blur(40px) saturate(180%);
                    border-right: 1px solid var(--glass-border);
                    padding: 44px 22px; display: flex; flex-direction: column; z-index: 20;
                }
                .logo-main { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; color: var(--text-primary); margin-bottom: 4px; }
                .logo-sub { font-size: 13px; color: var(--text-secondary); margin-bottom: 32px; }
                .menu-item {
                    padding: 14px 16px; border-radius: 10px; cursor: pointer;
                    color: var(--text-secondary); margin-bottom: 4px;
                    font-weight: 400; font-size: 14px;
                    display: flex; justify-content: space-between; align-items: center;
                    transition: all 0.2s;
                }
                .menu-item:hover { background: rgba(255,255,255,0.04); color: var(--text-primary); }
                .menu-item.active { background: rgba(255,255,255,0.08); color: var(--text-primary); font-weight: 600; }
                .count-badge {
                    background: rgba(255,255,255,0.08); padding: 3px 9px; border-radius: 7px;
                    font-size: 11px; color: var(--text-secondary); font-weight: 500;
                }
                .menu-item.active .count-badge { background: var(--text-primary); color: #000; font-weight: 700; }
                .btn {
                    background: var(--text-primary); color: #000; border: none;
                    padding: 13px; border-radius: 11px; font-weight: 600; cursor: pointer;
                    font-size: 13px; transition: 0.2s; text-align: center; font-family: var(--app-font);
                }
                .btn:hover { opacity: 0.85; }
                .btn-danger {
                    background: rgba(255,69,58,0.15); color: var(--accent-danger);
                    border: 1px solid rgba(255,69,58,0.3);
                }
                .btn-danger:hover { background: rgba(255,69,58,0.25); color: #fff; border-color: transparent; }
                .btn-ghost { background: rgba(255,255,255,0.06); color: var(--text-secondary); }
                .search-filter {
                    padding: 8px 12px; background: rgba(255,255,255,0.06);
                    border: 1px solid var(--glass-border); border-radius: 10px;
                    color: var(--text-primary); font-size: 13px; outline: none;
                    width: 100%; font-family: var(--app-font); transition: 0.2s;
                }
                .search-filter:focus { border-color: var(--accent-blue); }
                .search-filter::placeholder { color: var(--text-tertiary); }
                .main-content { flex: 1; overflow-y: auto; position: relative; }
                .header-bar {
                    padding: 22px 40px;
                    background: rgba(15,15,18,0.7); backdrop-filter: blur(25px);
                    border-bottom: 1px solid var(--glass-border);
                    position: sticky; top: 0; z-index: 10;
                    display: flex; justify-content: space-between; align-items: center; gap: 16px;
                }
                h3 { font-weight: 700; margin: 0; font-size: 22px; letter-spacing: -0.02em; color: var(--text-primary); white-space: nowrap; }
                .header-controls { display: flex; gap: 10px; align-items: center; }
                .grid-layout { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 20px; padding: 32px 40px; }
                .user-card {
                    background: var(--glass-card); border: 1px solid var(--glass-border);
                    border-radius: 18px; padding: 22px; text-align: center;
                    transition: all 0.3s cubic-bezier(0.25,0.8,0.25,1); position: relative;
                }
                .user-card:hover { background: var(--glass-card-hover); transform: translateY(-3px); border-color: var(--glass-highlight); }
                .user-card.active { background: rgba(41,151,255,0.08); border-color: rgba(41,151,255,0.4); }
                .avatar { width: 74px; height: 74px; border-radius: 50%; margin-bottom: 14px; object-fit: cover; border: 1px solid rgba(255,255,255,0.05); }
                .avatar.danger { box-shadow: 0 0 0 3px var(--accent-danger); }
                .avatar.success { box-shadow: 0 0 0 3px var(--accent-success); }
                .username { font-weight: 700; font-size: 14px; margin-bottom: 3px; }
                .fullname { font-size: 12px; color: var(--text-secondary); margin-bottom: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .card-actions { display: flex; justify-content: center; gap: 6px; flex-wrap: wrap; }
                .action-btn {
                    padding: 6px 14px; font-size: 11px; border-radius: 100px; font-weight: 600;
                    border: none; cursor: pointer; transition: 0.2s; font-family: var(--app-font);
                }
                .btn-select { background: rgba(255,255,255,0.08); color: var(--text-primary); }
                .btn-select:hover { background: rgba(255,255,255,0.15); }
                .btn-whitelist { background: transparent; color: var(--text-secondary); border: 1px solid rgba(255,255,255,0.06); }
                .btn-whitelist:hover { border-color: var(--text-secondary); color: var(--text-primary); }
                .btn-view-media { background: rgba(41,151,255,0.12); color: var(--accent-blue); border: 1px solid rgba(41,151,255,0.2); }
                .btn-view-media:hover { background: rgba(41,151,255,0.25); }
                .overlay-center { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; flex-direction: column; z-index: 5; }
                .progress-bar-wrap { width: 260px; height: 4px; background: rgba(255,255,255,0.08); border-radius: 2px; margin-top: 16px; overflow: hidden; }
                .progress-bar { height: 100%; background: var(--accent-blue); transition: width 0.3s; border-radius: 2px; width: 0%; }
                ::-webkit-scrollbar { width: 6px; }
                ::-webkit-scrollbar-track { background: transparent; }
                ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
            `;
            document.head.appendChild(style);

            const DEFAULTS = { whitelist: [] };
            let APP_CONFIG;
            try {
                APP_CONFIG = JSON.parse(localStorage.getItem('ig_manager_config')) || { ...DEFAULTS };
                if (!Array.isArray(APP_CONFIG.whitelist)) APP_CONFIG.whitelist = [];
            } catch { APP_CONFIG = { ...DEFAULTS }; }
            const saveConfig = () => localStorage.setItem('ig_manager_config', JSON.stringify(APP_CONFIG));

            const ToolManager = {
                state: {
                    following: [], followers: [], nonFollowers: [], mutuals: [],
                    selection: new Set(), currentView: 'non', filterText: ''
                },

                init() {
                    document.body.innerHTML = `
                        <div class="sidebar">
                            <div class="logo-main">UnLikeIt</div>
                            <div class="logo-sub">Relation Manager</div>
                            <div class="menu-item active" id="nav-non"><span>Non-Followers</span> <span class="count-badge" id="badge-non">0</span></div>
                            <div class="menu-item" id="nav-mut"><span>Mutuals</span> <span class="count-badge" id="badge-mut">0</span></div>
                            <div class="menu-item" id="nav-wl"><span>Whitelist</span> <span class="count-badge" id="badge-wl">${APP_CONFIG.whitelist.length}</span></div>
                            <div style="height:1px; background:var(--glass-border); margin:20px 0"></div>
                            <div style="font-size:12px; color:var(--text-secondary); margin-bottom:12px; text-align:center">
                                <span id="lbl-selected">0</span> selected
                            </div>
                            <button id="btn-execute" class="btn btn-danger" style="width:100%; opacity:0.5; cursor:not-allowed; margin-bottom:10px">Unfollow Selected</button>
                            <button id="btn-export" class="btn btn-ghost" style="width:100%; margin-bottom:10px">Export CSV</button>
                            <button id="btn-rescan" class="btn btn-ghost" style="width:100%; margin-bottom:10px">Rescan</button>
                            <button id="btn-exit" class="btn btn-ghost" style="width:100%">Exit</button>
                        </div>
                        <div class="main-content">
                            <div class="header-bar">
                                <h3 id="view-title">Non-Followers</h3>
                                <div class="header-controls">
                                    <input class="search-filter" id="filter-input" placeholder="Filter by username..." style="width:180px">
                                    <button class="btn" id="btn-toggle-all" style="padding:9px 18px; background:rgba(255,255,255,0.08); color:var(--text-primary); font-size:12px; white-space:nowrap">Select All</button>
                                </div>
                            </div>
                            <div id="grid-container" class="grid-layout">
                                <div class="overlay-center">
                                    <h2 style="font-size:26px; font-weight:700; letter-spacing:-0.03em; margin-bottom:12px">Ready to Analyze?</h2>
                                    <p style="color:var(--text-secondary); margin-bottom:28px; font-size:15px">Fetches your complete follower graph.</p>
                                    <button class="btn" id="btn-init-scan" style="padding:14px 32px; font-size:15px">Start Scan</button>
                                </div>
                            </div>
                        </div>
                    `;
                    this.bindEvents();
                },

                bindEvents() {
                    document.getElementById('btn-init-scan').onclick = () => this.performScan();
                    document.getElementById('btn-rescan').onclick = () => this.performScan();
                    document.getElementById('btn-execute').onclick = () => this.executeBatch();
                    document.getElementById('btn-toggle-all').onclick = () => this.toggleAll();
                    document.getElementById('btn-exit').onclick = () => { window.location.href = '/'; };
                    document.getElementById('btn-export').onclick = () => this.exportData();
                    document.getElementById('filter-input').oninput = (e) => {
                        this.state.filterText = e.target.value.toLowerCase();
                        this.renderGrid();
                    };
                    ['non', 'mut', 'wl'].forEach(k => {
                        document.getElementById('nav-' + k).onclick = () => this.switchView(k);
                    });
                    // Keyboard: Escape to go back
                    document.addEventListener('keydown', e => { if (e.key === 'Escape') window.location.href = '/'; });
                },

                async performScan() {
                    const uid = getUserId();
                    if (!uid) { alert('You must be logged in to Instagram.'); return; }
                    const grid = document.getElementById('grid-container');
                    grid.innerHTML = `
                        <div class="overlay-center">
                            <h3 style="font-size:20px; margin-bottom:8px">Scanning...</h3>
                            <p style="color:var(--text-secondary); font-size:14px; margin-bottom:16px">Fetched: <span id="progress-val" style="color:var(--accent-blue); font-variant-numeric:tabular-nums">0</span> users</p>
                            <div class="progress-bar-wrap"><div class="progress-bar" id="progress-bar"></div></div>
                            <p style="color:var(--text-tertiary); font-size:12px; margin-top:12px">Respecting rate limits — this may take a minute.</p>
                        </div>
                    `;
                    let total = 0;
                    const updateProgress = (n) => {
                        total = n;
                        const el = document.getElementById('progress-val');
                        if (el) el.textContent = n;
                    };
                    try {
                        const [following, followers] = await Promise.all([
                            InstagramAPI.fetchRelation(uid, 'following', updateProgress),
                            InstagramAPI.fetchRelation(uid, 'followers', updateProgress)
                        ]);
                        this.state.following = following;
                        this.state.followers = followers;
                        const followerIds = new Set(followers.map(u => u.pk || u.id));
                        this.state.nonFollowers = following.filter(u => !followerIds.has(u.pk || u.id));
                        this.state.mutuals = following.filter(u => followerIds.has(u.pk || u.id));
                        document.getElementById('badge-non').textContent = this.state.nonFollowers.length;
                        document.getElementById('badge-mut').textContent = this.state.mutuals.length;
                        document.getElementById('badge-wl').textContent = APP_CONFIG.whitelist.length;
                        this.switchView('non');
                    } catch (e) {
                        if (e.message === 'RATE_LIMIT') {
                            grid.innerHTML = `<div class="overlay-center"><h3>Rate Limited</h3><p style="color:var(--text-secondary)">Instagram throttled the request. Wait a few minutes, then try again.</p></div>`;
                        } else {
                            grid.innerHTML = `<div class="overlay-center"><h3>Scan Failed</h3><p style="color:var(--text-secondary)">${e.message}</p></div>`;
                        }
                    }
                },

                switchView(type) {
                    this.state.currentView = type;
                    this.state.selection.clear();
                    document.querySelectorAll('.menu-item').forEach(e => e.classList.remove('active'));
                    const navEl = document.getElementById('nav-' + type);
                    if (navEl) navEl.classList.add('active');
                    const titles = { non: 'Non-Followers', mut: 'Mutuals', wl: 'Whitelist' };
                    document.getElementById('view-title').textContent = titles[type] || '';
                    document.getElementById('filter-input').value = '';
                    this.state.filterText = '';
                    this.renderGrid();
                },

                getList() {
                    const t = this.state.currentView;
                    let list = [];
                    if (t === 'non') list = this.state.nonFollowers;
                    else if (t === 'mut') list = this.state.mutuals;
                    else if (t === 'wl') {
                        const all = [...this.state.following];
                        const wlSet = new Set(APP_CONFIG.whitelist);
                        const seen = new Set();
                        list = all.filter(u => {
                            if (!wlSet.has(u.username) || seen.has(u.pk)) return false;
                            seen.add(u.pk);
                            return true;
                        });
                    }
                    if (this.state.filterText) {
                        const q = this.state.filterText;
                        list = list.filter(u => u.username.toLowerCase().includes(q) || (u.full_name || '').toLowerCase().includes(q));
                    }
                    return list;
                },

                renderGrid() {
                    const grid = document.getElementById('grid-container');
                    grid.innerHTML = '';
                    this.updateControls();
                    const list = this.getList();
                    if (!list.length) {
                        grid.innerHTML = `<div class="overlay-center"><p style="color:var(--text-secondary); font-size:15px">No users found.</p></div>`;
                        return;
                    }
                    list.forEach(u => {
                        const isWl = APP_CONFIG.whitelist.includes(u.username);
                        const isNonFollower = !new Set(this.state.followers.map(f => f.pk || f.id)).has(u.pk || u.id);
                        const card = document.createElement('div');
                        card.className = 'user-card';
                        card.dataset.id = u.pk || u.id;

                        const picUrl = u.profile_pic_url || '';
                        card.innerHTML = `
                            <img src="${picUrl}" class="avatar ${isNonFollower ? 'danger' : 'success'}" onerror="this.style.visibility='hidden'">
                            <div class="username">${u.username}</div>
                            <div class="fullname">${u.full_name || ' '}</div>
                            <div class="card-actions">
                                <button class="action-btn btn-select">Select</button>
                                <button class="action-btn btn-whitelist" style="color:${isWl ? 'var(--accent-success)' : 'var(--text-secondary)'}">${isWl ? '✓ Safe' : 'Whitelist'}</button>
                                <button class="action-btn btn-view-media">Media</button>
                            </div>
                        `;
                        const btnSel = card.querySelector('.btn-select');
                        const btnWl = card.querySelector('.btn-whitelist');
                        const btnMedia = card.querySelector('.btn-view-media');

                        btnSel.onclick = () => {
                            if (this.state.selection.has(u)) {
                                this.state.selection.delete(u);
                                card.classList.remove('active');
                                btnSel.textContent = 'Select';
                                btnSel.style.background = '';
                                btnSel.style.color = '';
                            } else {
                                this.state.selection.add(u);
                                card.classList.add('active');
                                btnSel.style.background = 'var(--accent-blue)';
                                btnSel.style.color = '#fff';
                                btnSel.textContent = 'Selected';
                            }
                            this.updateControls();
                        };

                        btnWl.onclick = () => {
                            if (APP_CONFIG.whitelist.includes(u.username)) {
                                APP_CONFIG.whitelist = APP_CONFIG.whitelist.filter(x => x !== u.username);
                                btnWl.textContent = 'Whitelist';
                                btnWl.style.color = 'var(--text-secondary)';
                            } else {
                                APP_CONFIG.whitelist.push(u.username);
                                btnWl.textContent = '✓ Safe';
                                btnWl.style.color = 'var(--accent-success)';
                            }
                            saveConfig();
                            document.getElementById('badge-wl').textContent = APP_CONFIG.whitelist.length;
                        };

                        btnMedia.onclick = () => {
                            // Navigate to media downloader for this user
                            history.pushState({}, '', CONFIG.virtualRoute + '-media');
                            MediaDownloader.start(u.username);
                        };

                        grid.appendChild(card);
                    });
                },

                toggleAll() {
                    const list = this.getList();
                    const eligible = list.filter(u => !APP_CONFIG.whitelist.includes(u.username));
                    const allSelected = eligible.every(u => this.state.selection.has(u));
                    this.state.selection.clear();
                    const cards = document.querySelectorAll('.user-card');
                    if (!allSelected) {
                        eligible.forEach(u => this.state.selection.add(u));
                        cards.forEach(c => {
                            const uid = c.dataset.id;
                            const user = list.find(u => String(u.pk || u.id) === uid);
                            if (user && !APP_CONFIG.whitelist.includes(user.username)) {
                                c.classList.add('active');
                                const btn = c.querySelector('.btn-select');
                                btn.style.background = 'var(--accent-blue)';
                                btn.style.color = '#fff';
                                btn.textContent = 'Selected';
                            }
                        });
                    } else {
                        cards.forEach(c => {
                            c.classList.remove('active');
                            const btn = c.querySelector('.btn-select');
                            btn.style.background = '';
                            btn.style.color = '';
                            btn.textContent = 'Select';
                        });
                    }
                    this.updateControls();
                },

                updateControls() {
                    const c = this.state.selection.size;
                    document.getElementById('lbl-selected').textContent = c;
                    const btn = document.getElementById('btn-execute');
                    btn.style.opacity = c > 0 ? '1' : '0.5';
                    btn.style.cursor = c > 0 ? 'pointer' : 'not-allowed';
                },

                exportData() {
                    const list = this.getList();
                    if (!list.length) { alert('Nothing to export.'); return; }
                    exportCSV(list.map(u => ({
                        username: u.username,
                        full_name: u.full_name || '',
                        user_id: u.pk || u.id || '',
                        is_private: u.is_private || false,
                        follower_count: u.follower_count || '',
                        following_count: u.following_count || '',
                        whitelisted: APP_CONFIG.whitelist.includes(u.username)
                    })), `unlikeit_${this.state.currentView}_${Date.now()}.csv`);
                },

                async executeBatch() {
                    const arr = Array.from(this.state.selection);
                    if (!arr.length || !confirm(`Unfollow ${arr.length} user(s)?\nWhitelisted users are excluded automatically.`)) return;
                    const eligible = arr.filter(u => !APP_CONFIG.whitelist.includes(u.username));
                    if (!eligible.length) { alert('All selected users are whitelisted.'); return; }
                    const btn = document.getElementById('btn-execute');
                    let successCount = 0;
                    for (let i = 0; i < eligible.length; i++) {
                        const u = eligible[i];
                        btn.textContent = `Unfollowing ${i + 1} / ${eligible.length}...`;
                        const ok = await InstagramAPI.unfollow(u.pk || u.id);
                        if (ok) {
                            successCount++;
                            this.state.selection.delete(u);
                            this.state.following = this.state.following.filter(f => (f.pk || f.id) !== (u.pk || u.id));
                            this.state.nonFollowers = this.state.nonFollowers.filter(f => (f.pk || f.id) !== (u.pk || u.id));
                            // Remove card from DOM immediately
                            const card = document.querySelector(`.user-card[data-id="${u.pk || u.id}"]`);
                            if (card) { card.style.opacity = '0'; card.style.transform = 'scale(0.9)'; card.style.transition = '0.3s'; setTimeout(() => card.remove(), 300); }
                        }
                        await sleep(2000 + Math.random() * 1500);
                    }
                    btn.textContent = `✓ Done (${successCount} unfollowed)`;
                    document.getElementById('badge-non').textContent = this.state.nonFollowers.length;
                    this.updateControls();
                    setTimeout(() => { btn.textContent = 'Unfollow Selected'; }, 3000);
                }
            };

            ToolManager.init();
        }
    };

    // ─────────────────────────────────────────────
    // INTERACTION CLEANER MODULE (v2 — improved)
    // ─────────────────────────────────────────────
    const InteractionCleaner = {
        start() {
            const DEFAULTS = { profile: 'human', sessionLimit: 1000 };
            let APP_CONFIG;
            try { APP_CONFIG = JSON.parse(localStorage.getItem('unlikeit_config')) || { ...DEFAULTS }; }
            catch { APP_CONFIG = { ...DEFAULTS }; }

            const state = {
                isActive: localStorage.getItem('unlikeit_running') === 'true',
                isMinimized: false,
                lifetimeCount: parseInt(localStorage.getItem('unlikeit_total') || '0', 10),
                sessionCount: 0,
                startTime: null,
                sortApplied: false
            };

            const PROFILES = {
                human:   { batch: [20, 35],  delay: [600, 1100], cooldown: 4000 },
                stealth: { batch: [10, 20],  delay: [900, 1800], cooldown: 7000 },
                speed:   { batch: [40, 60],  delay: [300, 600],  cooldown: 2500 },
                machine: { batch: [80, 100], delay: [150, 300],  cooldown: 5000 }
            };
            const activeProfile = () => PROFILES[APP_CONFIG.profile] || PROFILES.human;

            const css = `
                :root {
                    --ui-font: 'Helvetica Neue', Helvetica, Arial, sans-serif;
                    --ui-glass: rgba(22,22,26,0.94);
                    --ui-border: 1px solid rgba(255,255,255,0.09);
                    --ios-blue: #2997FF;
                    --ios-green: #30D158;
                    --ios-red: #FF453A;
                    --ios-text: #F5F5F7;
                    --ios-muted: #86868B;
                }
                #ul-panel {
                    position: fixed; top: 28px; right: 28px; width: 330px;
                    background: var(--ui-glass);
                    backdrop-filter: blur(40px) saturate(180%); -webkit-backdrop-filter: blur(40px) saturate(180%);
                    border: var(--ui-border); border-radius: 18px;
                    box-shadow: 0 20px 50px rgba(0,0,0,0.5);
                    z-index: 2147483647; font-family: var(--ui-font); color: var(--ios-text);
                    font-size: 13px; overflow: hidden; letter-spacing: -0.01em;
                    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                }
                .ul-head {
                    padding: 14px 18px; background: rgba(255,255,255,0.025);
                    display: flex; justify-content: space-between; align-items: center;
                    border-bottom: 1px solid rgba(255,255,255,0.05); cursor: move; user-select: none;
                }
                .ul-title { font-weight: 600; font-size: 14px; }
                .ul-badge {
                    background: rgba(41,151,255,0.2); color: var(--ios-blue);
                    padding: 3px 8px; border-radius: 5px; font-size: 10px; font-weight: 600; margin-left: 8px;
                }
                .ul-ctrls span {
                    cursor: pointer; width: 24px; height: 24px; border-radius: 50%;
                    display: inline-flex; align-items: center; justify-content: center;
                    background: rgba(255,255,255,0.07); font-size: 12px; margin-left: 6px;
                    transition: 0.15s; color: var(--ios-muted);
                }
                .ul-ctrls span:hover { background: rgba(255,255,255,0.18); color: #fff; }
                .ul-body { padding: 18px; }
                .ul-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 18px; }
                .ul-card {
                    background: rgba(255,255,255,0.04); border-radius: 12px; padding: 14px;
                    text-align: center; border: var(--ui-border);
                }
                .ul-val { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 2px; }
                .ul-lbl { font-size: 10px; color: var(--ios-muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
                .ul-rate { font-size: 10px; color: var(--ios-muted); margin-top: 2px; }
                .ul-log {
                    height: 90px; background: rgba(0,0,0,0.2); border-radius: 10px; padding: 10px;
                    font-family: 'SF Mono', Menlo, monospace; font-size: 10px; overflow-y: auto;
                    color: #888; border: var(--ui-border); margin-bottom: 16px; display: flex; flex-direction: column-reverse;
                }
                .log-i { color: #5AC8FA; } .log-s { color: #30D158; } .log-w { color: #FFD60A; } .log-e { color: #FF453A; }
                .ul-log-item { margin-bottom: 4px; line-height: 1.4; }
                .ul-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 13px; color: #ccc; }
                #ul-panel select, #ul-panel input[type="number"] {
                    background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.06);
                    color: #fff; padding: 5px 10px; border-radius: 8px; outline: none;
                    font-family: var(--ui-font); text-align: right; transition: 0.15s;
                }
                #ul-panel select:hover, #ul-panel input[type="number"]:hover { background: rgba(255,255,255,0.13); }
                #ul-panel option { background: #222; }
                .ul-progress { height: 3px; background: rgba(255,255,255,0.06); border-radius: 2px; margin-bottom: 14px; overflow: hidden; }
                .ul-progress-fill { height: 100%; background: var(--ios-blue); transition: width 0.3s; border-radius: 2px; width: 0; }
                #ul-main-btn {
                    width: 100%; padding: 13px; border: none; border-radius: 10px;
                    background: #fff; color: #000; font-weight: 600; cursor: pointer;
                    transition: 0.2s; font-size: 13px; font-family: var(--ui-font); letter-spacing: -0.01em;
                }
                #ul-main-btn.active { background: rgba(255,69,58,0.15); color: var(--ios-red); border: 1px solid rgba(255,69,58,0.4); }
                #ul-main-btn:hover { opacity: 0.85; }
                .ul-log::-webkit-scrollbar { width: 3px; }
                .ul-log::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
            `;

            const humanizer = {
                gaussian(min, max) {
                    let u = 0, v = 0;
                    while (u === 0) u = Math.random();
                    while (v === 0) v = Math.random();
                    let n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
                    n = n / 10 + 0.5;
                    if (n > 1 || n < 0) return this.gaussian(min, max);
                    return Math.floor(n * (max - min) + min);
                },
                async sleep(min, max) { return sleep(this.gaussian(min, max)); },
                async realisticClick(el) {
                    if (!el) return;
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await this.sleep(50, 120);
                    ['mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
                }
            };

            const utils = {
                log(msg, type = 'i') { console.log(`[UnLikeIt] ${msg}`); ui.addLog(msg, type); },
                norm(t) { return (t || '').replace(/\s+/g, ' ').trim().toLowerCase(); },

                findNode(text) {
                    const target = this.norm(text);
                    for (const el of document.querySelectorAll('div[role="button"],button,span,li,[role="menuitem"],[role="option"],label')) {
                        const c = this.norm(el.textContent);
                        const a = this.norm(el.getAttribute('aria-label') || '');
                        if (c.includes(target) || a.includes(target)) return el;
                    }
                    return null;
                },

                async waitForNode(text, timeout = 15000) {
                    const end = Date.now() + timeout;
                    while (Date.now() < end) {
                        if (!state.isActive) return null;
                        const el = this.findNode(text);
                        if (el) return el;
                        await humanizer.sleep(300, 500);
                    }
                    return null;
                },

                async waitForAria(label, timeout = 5000) {
                    const end = Date.now() + timeout;
                    while (Date.now() < end) {
                        if (!state.isActive) return null;
                        const el = document.querySelector(`[aria-label="${label}"]`);
                        if (el) return el;
                        await humanizer.sleep(300, 500);
                    }
                    return null;
                },

                getScrollContainer() {
                    const main = document.querySelector('main[role="main"]');
                    return (main && main.scrollHeight > window.innerHeight) ? main : window;
                },

                async deepScroll() {
                    const c = this.getScrollContainer();
                    document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: 800, bubbles: true }));
                    if (c.scrollTo) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
                    else window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                },

                async activeWait(ms) {
                    const end = Date.now() + ms;
                    const c = this.getScrollContainer();
                    while (Date.now() < end) {
                        if (!state.isActive) return;
                        if (c.scrollBy) c.scrollBy(0, -150); else window.scrollBy(0, -150);
                        await humanizer.sleep(250, 400);
                        if (c.scrollBy) c.scrollBy(0, 350); else window.scrollBy(0, 350);
                        await humanizer.sleep(250, 400);
                    }
                },

                click(el) {
                    if (!el) return;
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    setTimeout(() => el.click(), 80);
                }
            };

            let ratePerHour = 0;

            const ui = {
                init() {
                    if (document.getElementById('ul-panel')) return;
                    const s = document.createElement('style');
                    s.textContent = css;
                    document.head.appendChild(s);
                    const div = document.createElement('div');
                    div.id = 'ul-panel';
                    div.innerHTML = `
                        <div class="ul-head">
                            <div class="ul-title">Interaction Cleaner <span class="ul-badge">BETA</span></div>
                            <div class="ul-ctrls"><span id="ul-min">−</span><span id="ul-close">×</span></div>
                        </div>
                        <div class="ul-body" id="ul-body">
                            <div class="ul-grid">
                                <div class="ul-card"><div class="ul-val" id="v-session" style="color:#2997FF">0</div><div class="ul-lbl">Session</div></div>
                                <div class="ul-card"><div class="ul-val" id="v-total" style="color:#30D158">${state.lifetimeCount}</div><div class="ul-lbl">All Time</div><div class="ul-rate" id="v-rate"></div></div>
                            </div>
                            <div class="ul-progress"><div class="ul-progress-fill" id="ul-prog"></div></div>
                            <div class="ul-log" id="ul-log"><div class="ul-log-item log-i">> Ready. Navigate to Your Activity.</div></div>
                            <div class="ul-row"><label>Safety Profile</label><select id="ul-profile"><option value="human">Human</option><option value="stealth">Stealth</option><option value="speed">Speed</option><option value="machine">Machine</option></select></div>
                            <div class="ul-row"><label>Limit</label><input id="ul-limit" type="number" value="${APP_CONFIG.sessionLimit}" style="width:80px"></div>
                            <button id="ul-main-btn">INITIALIZE CLEANER</button>
                        </div>
                    `;
                    document.body.appendChild(div);

                    // Make panel draggable
                    let dragging = false, ox, oy;
                    div.querySelector('.ul-head').addEventListener('mousedown', e => {
                        dragging = true; ox = e.clientX - div.offsetLeft; oy = e.clientY - div.offsetTop;
                        document.addEventListener('mousemove', drag);
                        document.addEventListener('mouseup', () => { dragging = false; document.removeEventListener('mousemove', drag); }, { once: true });
                    });
                    function drag(e) {
                        if (!dragging) return;
                        div.style.right = 'auto'; div.style.top = 'auto';
                        div.style.left = (e.clientX - ox) + 'px'; div.style.top = (e.clientY - oy) + 'px';
                    }

                    document.getElementById('ul-main-btn').onclick = controller.toggle;
                    document.getElementById('ul-close').onclick = () => { div.remove(); state.isActive = false; localStorage.setItem('unlikeit_running', 'false'); };
                    document.getElementById('ul-min').onclick = () => {
                        const body = document.getElementById('ul-body');
                        state.isMinimized = !state.isMinimized;
                        body.style.display = state.isMinimized ? 'none' : 'block';
                    };
                    document.getElementById('ul-profile').value = APP_CONFIG.profile;
                    document.getElementById('ul-profile').onchange = e => { APP_CONFIG.profile = e.target.value; this.save(); };
                    document.getElementById('ul-limit').onchange = e => { APP_CONFIG.sessionLimit = parseInt(e.target.value) || 1000; this.save(); };

                    if (state.isActive) {
                        document.getElementById('ul-main-btn').textContent = 'STOP PROCESS';
                        document.getElementById('ul-main-btn').classList.add('active');
                        this.addLog('Recovering session...', 'w');
                        controller.start();
                    }
                },
                addLog(msg, type = 'i') {
                    const box = document.getElementById('ul-log');
                    if (!box) return;
                    const item = document.createElement('div');
                    item.className = `ul-log-item log-${type}`;
                    const t = new Date().toLocaleTimeString('en-US', { hour12: false });
                    item.textContent = `[${t}] ${msg}`;
                    box.prepend(item);
                    if (box.children.length > 60) box.lastChild.remove();
                },
                updateStats(n) {
                    const sEl = document.getElementById('v-session');
                    const tEl = document.getElementById('v-total');
                    const rEl = document.getElementById('v-rate');
                    const pEl = document.getElementById('ul-prog');
                    if (sEl) sEl.textContent = n;
                    if (tEl) tEl.textContent = state.lifetimeCount;
                    if (state.startTime && n > 0) {
                        const mins = (Date.now() - state.startTime) / 60000;
                        ratePerHour = Math.round((n / mins) * 60);
                        if (rEl) rEl.textContent = `~${ratePerHour}/hr`;
                    }
                    const pct = Math.min((n / APP_CONFIG.sessionLimit) * 100, 100);
                    if (pEl) pEl.style.width = pct + '%';
                },
                save() { localStorage.setItem('unlikeit_config', JSON.stringify(APP_CONFIG)); }
            };

            const controller = {
                toggle() {
                    state.isActive = !state.isActive;
                    localStorage.setItem('unlikeit_running', state.isActive);
                    const btn = document.getElementById('ul-main-btn');
                    if (state.isActive) {
                        btn.textContent = 'STOP PROCESS';
                        btn.classList.add('active');
                        ui.addLog('Process started', 's');
                        controller.start();
                    } else {
                        btn.textContent = 'RESUME';
                        btn.classList.remove('active');
                        ui.addLog('Process paused', 'w');
                    }
                },

                async start() {
                    if (!state.startTime) state.startTime = Date.now();
                    try {
                        await humanizer.sleep(800, 1500);
                        await this.enforceSortOrder();
                        while (state.isActive) {
                            if (state.sessionCount >= APP_CONFIG.sessionLimit) {
                                ui.addLog(`Limit reached (${APP_CONFIG.sessionLimit}). Done.`, 's');
                                this.toggle(); break;
                            }
                            if (!await this.enterSelectMode()) {
                                ui.addLog('Cannot find Select button. Retrying...', 'w');
                                await humanizer.sleep(2000, 3500); continue;
                            }
                            const prof = activeProfile();
                            const batchSize = humanizer.gaussian(prof.batch[0], prof.batch[1]);
                            const items = await this.gatherItems(batchSize);
                            if (!items.length) {
                                ui.addLog('No more items. All done!', 's');
                                this.toggle(); break;
                            }
                            ui.addLog(`Selecting ${items.length} items...`, 'i');
                            for (const item of items) {
                                if (!state.isActive) break;
                                await humanizer.realisticClick(item);
                                await humanizer.sleep(Math.floor(prof.delay[0] * 0.3), Math.floor(prof.delay[1] * 0.5));
                            }
                            if (state.isActive) await this.executeDeletion(prof, items.length);
                            // Occasional longer break (realistic human behavior)
                            if (Math.random() < 0.08) {
                                const breakMs = humanizer.gaussian(18000, 35000);
                                ui.addLog(`☕ Micro-break (${Math.round(breakMs / 1000)}s)...`, 'i');
                                await humanizer.sleep(breakMs, breakMs);
                            }
                        }
                    } catch (err) {
                        ui.addLog(`Error: ${err.message}`, 'e');
                        console.error('[UnLikeIt]', err);
                        state.isActive = false;
                        const btn = document.getElementById('ul-main-btn');
                        if (btn) { btn.textContent = 'Error — Click to Retry'; btn.classList.remove('active'); }
                    }
                },

                async enforceSortOrder() {
                    if (state.sortApplied) return;
                    // Wait for content to load
                    await humanizer.sleep(1500, 2500);
                    window.scrollTo(0, 0);
                    ui.addLog('Checking sort order...', 'i');
                    const sortBtn = await utils.waitForNode('Sort', 10000);
                    if (!sortBtn) { ui.addLog('Sort button not found. Continuing.', 'w'); return; }
                    await humanizer.realisticClick(sortBtn);
                    await humanizer.sleep(1000, 1600);
                    const oldestOpt = await utils.waitForAria('Oldest to Newest', 5000);
                    if (!oldestOpt) { document.body.click(); ui.addLog('Sort option missing.', 'w'); return; }
                    await humanizer.realisticClick(oldestOpt);
                    await humanizer.sleep(700, 1100);
                    const applyBtn = await utils.waitForAria('Apply', 5000);
                    if (applyBtn) {
                        await humanizer.realisticClick(applyBtn);
                        state.sortApplied = true;
                        ui.addLog('Sort applied: Oldest first', 's');
                        await utils.activeWait(5000);
                    } else {
                        document.body.click();
                    }
                },

                async enterSelectMode() {
                    // Already in select mode?
                    if (document.querySelector('[aria-label="Toggle checkbox"]')) return true;
                    await utils.activeWait(1500);
                    const btn = await utils.waitForNode('Select', 4000);
                    if (!btn) return false;
                    await humanizer.realisticClick(btn);
                    return !!(await utils.waitForAria('Toggle checkbox', 5000));
                },

                async gatherItems(target) {
                    let last = -1, attempts = 0;
                    while (attempts < 7) {
                        if (!state.isActive) break;
                        const boxes = document.querySelectorAll('[aria-label="Toggle checkbox"]');
                        ui.addLog(`Gathering: ${boxes.length}/${target} (try ${attempts + 1})`, 'i');
                        if (boxes.length >= target) return Array.from(boxes).slice(0, target);
                        await utils.deepScroll();
                        await humanizer.sleep(2000 + attempts * 400, 3200 + attempts * 400);
                        const newCount = document.querySelectorAll('[aria-label="Toggle checkbox"]').length;
                        if (newCount === last) attempts++; else { attempts = 0; last = newCount; }
                        last = newCount;
                    }
                    return Array.from(document.querySelectorAll('[aria-label="Toggle checkbox"]')).slice(0, target);
                },

                async executeDeletion(prof, count) {
                    // Find action button — wider selector set for multi-language support
                    const actionKeywords = ['remove', 'unlike', 'gefällt mir nicht', 'unlike all', 'j\'aime plus', 'non mi piace'];
                    let actionBtn = null;
                    for (const el of document.querySelectorAll('button, span[role="button"], div[role="button"]')) {
                        const t = utils.norm(el.textContent);
                        if (actionKeywords.some(k => t.includes(k))) { actionBtn = el; break; }
                    }
                    if (!actionBtn) {
                        // Try header area buttons
                        const headerBtns = document.querySelectorAll('header button, [role="toolbar"] button');
                        actionBtn = Array.from(headerBtns).find(b => b.textContent.trim().length > 0);
                    }
                    if (!actionBtn) { ui.addLog('Action button not found', 'e'); return; }

                    await humanizer.sleep(prof.delay[0], prof.delay[1]);
                    utils.click(actionBtn);
                    await humanizer.sleep(800, 1400);

                    // Confirm dialog
                    const confirmKeywords = ['unlike', 'remove', 'delete', 'confirm', 'ok'];
                    const confirmBtn = Array.from(document.querySelectorAll('button')).find(b => {
                        const t = utils.norm(b.textContent);
                        return confirmKeywords.some(k => t === k) && b.getAttribute('tabindex') === '0';
                    });
                    if (confirmBtn) {
                        utils.click(confirmBtn);
                        if (count > 0) {
                            state.sessionCount += count;
                            state.lifetimeCount += count;
                            localStorage.setItem('unlikeit_total', String(state.lifetimeCount));
                            ui.updateStats(state.sessionCount);
                        }
                        ui.addLog(`✓ Deleted ${count}. Cooling down...`, 's');
                        await humanizer.sleep(prof.cooldown, prof.cooldown + 2500);
                    } else {
                        ui.addLog('Confirm dialog missing', 'e');
                        // Try clicking away to dismiss any stray dialog
                        document.body.click();
                        await humanizer.sleep(1000, 1500);
                    }
                }
            };

            // Network guard with proper rate limit backoff
            (function initNetworkGuard() {
                const orig = window.fetch;
                let rateLimitTimer = null;
                window.fetch = async (...args) => {
                    try {
                        const res = await orig(...args);
                        if (res.status === 429) {
                            ui.addLog('🛑 RATE LIMIT — pausing 10 min', 'e');
                            state.isActive = false;
                            const btn = document.getElementById('ul-main-btn');
                            if (btn) { btn.textContent = '⏳ Cooling Down (10m)...'; btn.classList.add('active'); }
                            clearTimeout(rateLimitTimer);
                            rateLimitTimer = setTimeout(() => {
                                ui.addLog('Resuming after rate limit...', 'w');
                                if (btn) { btn.textContent = 'RESUME'; btn.classList.remove('active'); }
                            }, 600000);
                        }
                        return res;
                    } catch (e) { return orig(...args); }
                };
            })();

            ui.init();
        }
    };

    // ─────────────────────────────────────────────
    // MASTER DASHBOARD UI
    // ─────────────────────────────────────────────
    const MasterUI = {
        init() {
            // Don't inject on virtual routes
            if ([CONFIG.virtualRoute, CONFIG.virtualRoute + '-media'].some(r => window.location.pathname.startsWith(r))) return;

            // Auto-start cleaner if flag is set
            if ((localStorage.getItem('unlikeit_running') === 'true' || sessionStorage.getItem('unlikeit_force_open') === 'true')
                && CONFIG.cleanerRoutes.some(r => window.location.pathname.startsWith(r))) {
                sessionStorage.removeItem('unlikeit_force_open');
                InteractionCleaner.start();
            }

            // Inject FAB button
            const fab = document.createElement('div');
            Object.assign(fab.style, {
                position: 'fixed', bottom: '22px', right: '22px',
                height: '46px', borderRadius: '23px', padding: '0 22px',
                background: 'rgba(255,255,255,0.08)',
                backdropFilter: 'blur(30px) saturate(180%)',
                boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
                border: '1px solid rgba(255,255,255,0.1)',
                cursor: 'pointer', zIndex: '999999',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '14px', color: '#fff', fontWeight: '700', letterSpacing: '-0.02em',
                transition: 'all 0.3s cubic-bezier(0.175,0.885,0.32,1.275)',
                fontFamily: "'Helvetica Neue', Helvetica, sans-serif",
                userSelect: 'none'
            });
            fab.textContent = 'UnLikeIt';
            fab.title = 'Open UnLikeIt';
            fab.onmouseover = () => { fab.style.transform = 'scale(1.05) translateY(-2px)'; fab.style.background = 'rgba(255,255,255,0.13)'; };
            fab.onmouseout = () => { fab.style.transform = ''; fab.style.background = 'rgba(255,255,255,0.08)'; };
            fab.onclick = this.showDashboard;
            document.body.appendChild(fab);
        },

        showDashboard() {
            const overlay = document.createElement('div');
            Object.assign(overlay.style, {
                position: 'fixed', inset: '0',
                background: 'rgba(5,5,8,0.65)',
                backdropFilter: 'blur(50px) saturate(150%)',
                zIndex: '1000000', display: 'flex', justifyContent: 'center', alignItems: 'center',
                opacity: '0', transition: 'opacity 0.35s ease',
                fontFamily: "'Helvetica Neue', Helvetica, sans-serif"
            });

            const cardBase = `
                background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
                border-radius: 22px; padding: 36px 28px; width: 210px; text-align: center;
                cursor: pointer; transition: all 0.35s cubic-bezier(0.25,0.8,0.25,1);
                display: flex; flex-direction: column; align-items: center;
                box-shadow: 0 8px 32px rgba(0,0,0,0.12);
            `;
            const iconBox = (gradient, shadow) =>
                `font-size:32px; margin-bottom:18px; background:${gradient}; width:64px; height:64px; border-radius:18px; display:flex; align-items:center; justify-content:center; box-shadow:${shadow}`;

            overlay.innerHTML = `
                <div style="text-align:center; color:#fff">
                    <h1 style="margin-bottom:44px; font-weight:800; font-size:30px; letter-spacing:-0.04em; background:linear-gradient(135deg,#fff 40%,#888); -webkit-background-clip:text; -webkit-text-fill-color:transparent; line-height:1.2; padding-bottom:4px">UnLikeIt <span style="-webkit-text-fill-color:#86868B;font-size:14px;font-weight:500">v${CONFIG.version}</span></h1>
                    <div style="display:flex; gap:24px; flex-wrap:wrap; justify-content:center">
                        <div id="c-rel" style="${cardBase}">
                            <div style="${iconBox('linear-gradient(135deg,#2997FF,#007AFF)', '0 10px 28px rgba(41,151,255,0.35)')}">👥</div>
                            <h3 style="margin:0 0 6px; font-size:16px; font-weight:700; color:#F5F5F7">Relations</h3>
                            <p style="color:#86868B; font-size:13px; margin:0; line-height:1.4">Follower Analysis<br>& Bulk Unfollow</p>
                        </div>
                        <div id="c-clean" style="${cardBase}">
                            <div style="${iconBox('linear-gradient(135deg,#FF453A,#FF3B30)', '0 10px 28px rgba(255,69,58,0.35)')}">🗑️</div>
                            <h3 style="margin:0 0 6px; font-size:16px; font-weight:700; color:#F5F5F7">Cleaner</h3>
                            <p style="color:#86868B; font-size:13px; margin:0; line-height:1.4">Bulk Like &<br>Comment Removal</p>
                        </div>
                        <div id="c-media" style="${cardBase}">
                            <div style="${iconBox('linear-gradient(135deg,#30D158,#25A244)', '0 10px 28px rgba(48,209,88,0.3)')}">📥</div>
                            <h3 style="margin:0 0 6px; font-size:16px; font-weight:700; color:#F5F5F7">Downloader</h3>
                            <p style="color:#86868B; font-size:13px; margin:0; line-height:1.4">Posts, Stories &<br>Profile Pictures</p>
                        </div>
                    </div>
                    <div style="margin-top:36px">
                        <a href="https://ko-fi.com/vigneshrapaka" target="_blank" style="color:rgba(255,255,255,0.45); text-decoration:none; font-size:12px; font-weight:500">
                           Love the tool? <span style="color:#FF5E5B">Buy me a coffee ☕</span>
                        </a>
                    </div>
                    <div style="margin-top:14px; color:rgba(255,255,255,0.25); font-size:13px; cursor:pointer" id="close-dash">Close  ·  Esc</div>
                </div>
            `;
            document.body.appendChild(overlay);
            requestAnimationFrame(() => overlay.style.opacity = '1');

            // Keyboard: Escape to close
            const onKey = e => { if (e.key === 'Escape') { closeOverlay(); document.removeEventListener('keydown', onKey); } };
            document.addEventListener('keydown', onKey);

            const closeOverlay = () => { overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 350); };

            const hover = (el, on) => {
                el.style.transform = on ? 'translateY(-6px)' : '';
                el.style.background = on ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.05)';
            };

            const relCard = document.getElementById('c-rel');
            relCard.onmouseenter = e => hover(e.currentTarget, true);
            relCard.onmouseleave = e => hover(e.currentTarget, false);
            relCard.onclick = () => {
                closeOverlay();
                setTimeout(() => {
                    history.pushState({}, '', CONFIG.virtualRoute);
                    RelationManager.start();
                }, 300);
            };

            const cleanCard = document.getElementById('c-clean');
            cleanCard.onmouseenter = e => hover(e.currentTarget, true);
            cleanCard.onmouseleave = e => hover(e.currentTarget, false);
            cleanCard.onclick = () => {
                const onPage = CONFIG.cleanerRoutes.some(r => window.location.pathname.startsWith(r));
                if (onPage) {
                    closeOverlay();
                    setTimeout(() => InteractionCleaner.start(), 300);
                } else if (confirm("The Cleaner needs the 'Your Activity' page. Go there now?")) {
                    sessionStorage.setItem('unlikeit_force_open', 'true');
                    window.location.href = 'https://www.instagram.com/your_activity/interactions/likes';
                }
            };

            const mediaCard = document.getElementById('c-media');
            mediaCard.onmouseenter = e => hover(e.currentTarget, true);
            mediaCard.onmouseleave = e => hover(e.currentTarget, false);
            mediaCard.onclick = () => {
                closeOverlay();
                setTimeout(() => {
                    history.pushState({}, '', CONFIG.virtualRoute + '-media');
                    MediaDownloader.start();
                }, 300);
            };

            document.getElementById('close-dash').onclick = closeOverlay;
            overlay.onclick = e => { if (e.target === overlay) closeOverlay(); };
        }
    };

    // ─────────────────────────────────────────────
    // BOOTSTRAP
    // ─────────────────────────────────────────────
    if (window.location.pathname === CONFIG.virtualRoute) {
        RelationManager.start();
    } else if (window.location.pathname === CONFIG.virtualRoute + '-media') {
        MediaDownloader.start();
    } else {
        if (document.readyState === 'loading') {
            window.addEventListener('DOMContentLoaded', () => MasterUI.init());
        } else {
            MasterUI.init();
        }
    }

})();
