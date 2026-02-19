// ===========================================================================
// app.js - A-Talk Frontend v5.0 (Socket.io + VirtualScroll + 投票 + 経済)
// ===========================================================================

(function () {
  'use strict';

  // ─── State ───
  var currentView = 'timeline';
  var timelineOffset = 0;
  var TIMELINE_LIMIT = 20;
  var timelineLoading = false;
  var timelineHasMore = true;
  var currentUserSort = 'follower';
  var currentThreadSort = 'recent';
  var currentThreadDetailId = null;

  var $ = function(id) { return document.getElementById(id); };
  var $timelinePosts = $('timeline-posts');
  var $timelineLoading = $('timeline-loading');
  var $timelineSentinel = $('timeline-sentinel');
  var $timelineEmpty = $('timeline-empty');
  var $trendingBar = $('trending-bar');
  var $tipFeed = $('tip-feed');
  var $personalityFeed = $('personality-feed');
  var $postModal = $('post-modal');
  var $modalPost = $('modal-post');
  var $modalCommentsList = $('modal-comments-list');
  var $modalCommentsLoading = $('modal-comments-loading');
  var $modalCommentsEmpty = $('modal-comments-empty');
  var $modalReactionsHeader = $('modal-reactions-header');
  var $modalReactionsList = $('modal-reactions-list');
  var $modalReactionsLoading = $('modal-reactions-loading');
  var $modalReactionsTrigger = $('modal-reactions-trigger');
  var $usersList = $('users-list');
  var $followerRanking = $('follower-ranking');
  var $userModal = $('user-modal');
  var $userModalContent = $('user-modal-content');
  var $dashboardContent = $('dashboard-content');
  var $adminContent = $('admin-content');
  var $threadsList = $('threads-list');
  var $threadsEmpty = $('threads-empty');
  var $threadDetailHeader = $('thread-detail-header');
  var $threadDetailVotes = $('thread-detail-votes');
  var $threadDetailSummary = $('thread-detail-summary');
  var $threadDetailPosts = $('thread-detail-posts');
  var $shopContent = $('shop-content');
  var $economyStatus = $('economy-status');
  var $auctionSection = $('auction-section');
  var $tipOverlay = $('tip-effect-overlay');
  var $tipContent = $('tip-effect-content');
  var $wsStatus = $('ws-status');

  // ─── Utilities ───
  function formatTime(isoString) {
    if (!isoString) return '';
    var d = new Date(isoString.includes('Z') ? isoString : isoString + 'Z');
    var sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return '今';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + '分前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + '時間前';
    var day = Math.floor(hr / 24);
    if (day < 7) return day + '日前';
    return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
  }
  function escapeHtml(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
  function renderPostContent(c) { return escapeHtml(c).replace(/\[(.+?)\]/g, '<span class="post-media">[$1]</span>'); }

  // ─── Socket.io ───
  var socket = null;
  function initSocket() {
    if (typeof io === 'undefined') {
      console.warn('[WS] Socket.io client not loaded');
      $wsStatus.textContent = 'WS: 未読込';
      $wsStatus.className = 'ws-status ws-disconnected';
      return;
    }
    try {
      socket = io({
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionAttempts: 10,
        timeout: 10000,
        forceNew: true,
      });
      socket.on('connect', function() {
        console.log('[WS] Connected:', socket.id);
        $wsStatus.textContent = 'WS: 接続中';
        $wsStatus.className = 'ws-status ws-connected';
      });
      socket.on('disconnect', function(reason) {
        console.log('[WS] Disconnected:', reason);
        $wsStatus.textContent = 'WS: 切断';
        $wsStatus.className = 'ws-status ws-disconnected';
      });
      socket.on('connect_error', function(err) {
        console.warn('[WS] Connection error:', err.message);
        $wsStatus.textContent = 'WS: 再接続中';
        $wsStatus.className = 'ws-status ws-disconnected';
      });

      // リアルタイム投稿
      socket.on('new_post', function(post) {
        if (currentView === 'timeline') {
          var el = createPostCard(post);
          el.classList.add('new-post');
          $timelinePosts.insertBefore(el, $timelinePosts.firstChild);
          timelineOffset++;
          $timelineEmpty.style.display = 'none';
          // 仮想スクロール: 古い要素を削除
          while ($timelinePosts.children.length > 100) {
            $timelinePosts.removeChild($timelinePosts.lastChild);
          }
        }
        if (currentView === 'thread-detail' && post.threadId === currentThreadDetailId) {
          loadThreadDetail(currentThreadDetailId);
        }
      });

      // リアルタイム投げ銭
      socket.on('tip', function(data) {
        if (data.effectTier !== 'normal') {
          showTipEffect(data.fromUsername, data.toUsername, data.amount, data.effectTier);
        }
        updateTipFeedItem(data);
      });

      // リアルタイムバッジ購入
      socket.on('badge_purchase', function(data) {
        // 通知を表示
      });

      // リアルタイム投票
      socket.on('vote', function(data) {
        if (currentView === 'thread-detail' && data.threadId === currentThreadDetailId) {
          renderVoteSection(data.threadId, data.votes);
        }
      });

      // 性格進化
      socket.on('personality_evolution', function(data) {
        showPersonalityEvolution(data);
      });
    } catch (e) {
      console.error('[WS] Init error:', e);
      $wsStatus.textContent = 'WS: エラー';
      $wsStatus.className = 'ws-status ws-disconnected';
    }
  }

  function updateTipFeedItem(data) {
    $tipFeed.style.display = 'block';
    var item = document.createElement('div');
    item.className = 'tip-feed-item tip-tier-tag-' + data.effectTier;
    item.innerHTML = escapeHtml(data.fromUsername) + ' → ' + escapeHtml(data.toUsername) +
      ' <strong>' + data.amount + 'pt</strong>' +
      (data.effectTier !== 'normal' ? ' <span class="tip-tier-mini">' + data.effectTier.toUpperCase() + '</span>' : '') +
      ' <span class="tip-feed-time">今</span>';
    var itemsDiv = $tipFeed.querySelector('.tip-feed-items');
    if (!itemsDiv) {
      $tipFeed.innerHTML = '<div class="tip-feed-label">最近の投げ銭</div><div class="tip-feed-items"></div>';
      itemsDiv = $tipFeed.querySelector('.tip-feed-items');
    }
    itemsDiv.insertBefore(item, itemsDiv.firstChild);
    while (itemsDiv.children.length > 3) itemsDiv.removeChild(itemsDiv.lastChild);
  }

  function showPersonalityEvolution(data) {
    $personalityFeed.style.display = 'block';
    $personalityFeed.innerHTML = '<div class="personality-notification">' +
      '<span class="personality-icon">*</span> ' +
      escapeHtml(data.username) + ' の性格が変化しました: ' +
      escapeHtml(data.newPersonality || '') + '</div>';
    setTimeout(function() { $personalityFeed.style.display = 'none'; }, 8000);
  }

  // ─── 投げ銭エフェクトシステム ───
  var TIP_SOUNDS = {
    normal: { freqs: [523], dur: 150, type: 'sine' },
    rare: { freqs: [523, 659], dur: 200, type: 'sine' },
    epic: { freqs: [523, 659, 784], dur: 250, type: 'triangle' },
    legendary: { freqs: [523, 659, 784, 1047], dur: 300, type: 'triangle' },
  };
  function playTipSound(tier) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var data = TIP_SOUNDS[tier] || TIP_SOUNDS.normal;
      data.freqs.forEach(function(freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = data.type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + data.dur / 1000);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.12);
        osc.stop(ctx.currentTime + i * 0.12 + data.dur / 1000 + 0.1);
      });
      setTimeout(function() { ctx.close(); }, 2000);
    } catch (e) {}
  }

  var TIER_PARTICLES = {
    normal: { count: 5, symbols: ['*'], colors: ['#ff9800'] },
    rare: { count: 10, symbols: ['*', '+'], colors: ['#2196f3', '#03a9f4'] },
    epic: { count: 20, symbols: ['*', '+', '#'], colors: ['#9c27b0', '#e040fb', '#ce93d8'] },
    legendary: { count: 35, symbols: ['*', '+', '#', '@'], colors: ['#ffd700', '#ff6f00', '#ffab00', '#ff3d00'] },
  };

  function showTipEffect(fromName, toName, amount, tier) {
    var cfg = TIER_PARTICLES[tier] || TIER_PARTICLES.normal;
    $tipContent.innerHTML = '';
    $tipOverlay.style.display = 'flex';
    $tipOverlay.className = 'tip-effect-overlay tip-tier-' + tier;
    var label = document.createElement('div');
    label.className = 'tip-label tip-label-' + tier;
    var tierLabel = tier === 'legendary' ? 'LEGENDARY' : tier === 'epic' ? 'EPIC' : tier === 'rare' ? 'RARE' : '';
    label.innerHTML = (tierLabel ? '<div class="tip-tier-label">' + tierLabel + '</div>' : '') +
      '<div class="tip-amount">' + amount + ' pt</div>' +
      '<div class="tip-names">' + escapeHtml(fromName) + ' → ' + escapeHtml(toName) + '</div>';
    $tipContent.appendChild(label);
    for (var i = 0; i < cfg.count; i++) {
      var p = document.createElement('div');
      p.className = 'tip-particle';
      p.textContent = cfg.symbols[Math.floor(Math.random() * cfg.symbols.length)];
      p.style.color = cfg.colors[Math.floor(Math.random() * cfg.colors.length)];
      p.style.left = Math.random() * 100 + '%';
      p.style.top = Math.random() * 100 + '%';
      p.style.animationDelay = (Math.random() * 0.5) + 's';
      p.style.animationDuration = (1 + Math.random() * 1.5) + 's';
      p.style.fontSize = (0.8 + Math.random() * 1.5) + 'rem';
      $tipContent.appendChild(p);
    }
    playTipSound(tier);
    var dur = tier === 'legendary' ? 4000 : tier === 'epic' ? 3000 : tier === 'rare' ? 2500 : 2000;
    setTimeout(function() { $tipOverlay.style.display = 'none'; $tipContent.innerHTML = ''; }, dur);
  }

  // ─── Intersection Observer (遅延読み込み) ───
  var observer = null;
  function setupIntersectionObserver() {
    if (!('IntersectionObserver' in window)) return;
    observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting && timelineHasMore && !timelineLoading && currentView === 'timeline') {
          loadTimeline(true);
        }
      });
    }, { rootMargin: '200px' });
    if ($timelineSentinel) observer.observe($timelineSentinel);
  }

  // ─── ナビゲーション ───
  document.querySelectorAll('.nav-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchView(btn.dataset.view); });
  });

  function switchView(view) {
    currentView = view;
    document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
    var ab = document.querySelector('.nav-btn[data-view="' + view + '"]');
    if (ab) ab.classList.add('active');
    document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
    var t = $(('view-' + view));
    if (t) t.classList.add('active');

    if (view === 'timeline') { loadTrending(); loadRecentTips(); }
    if (view === 'threads') loadThreads();
    if (view === 'users') loadUsers();
    if (view === 'shop') loadShop();
    if (view === 'dashboard') loadDashboard();
    if (view === 'admin') loadAdmin();
  }

  // ─── トレンド ───
  async function loadTrending() {
    try {
      var res = await fetch('/api/trending');
      var data = await res.json();
      if (data.topics && data.topics.length > 0) {
        $trendingBar.style.display = 'block';
        var html = '<div class="trending-label">トレンド</div><div class="trending-tags">';
        for (var t of data.topics.slice(0, 8)) html += '<span class="trending-tag">' + escapeHtml(t.topic) + '</span>';
        html += '</div>';
        $trendingBar.innerHTML = html;
      } else $trendingBar.style.display = 'none';
    } catch (e) { $trendingBar.style.display = 'none'; }
  }

  // ─── 最近の投げ銭 ───
  async function loadRecentTips() {
    try {
      var res = await fetch('/api/tips/recent?limit=5');
      var data = await res.json();
      if (!data.tips || data.tips.length === 0) { $tipFeed.style.display = 'none'; return; }
      $tipFeed.style.display = 'block';
      var html = '<div class="tip-feed-label">最近の投げ銭</div><div class="tip-feed-items">';
      for (var t of data.tips.slice(0, 3)) {
        var tc = 'tip-tier-tag-' + t.effect_tier;
        html += '<div class="tip-feed-item ' + tc + '">' + escapeHtml(t.from_username) + ' → ' + escapeHtml(t.to_username) +
          ' <strong>' + t.amount + 'pt</strong>' +
          (t.effect_tier !== 'normal' ? ' <span class="tip-tier-mini">' + t.effect_tier.toUpperCase() + '</span>' : '') +
          ' <span class="tip-feed-time">' + formatTime(t.created_at) + '</span></div>';
      }
      html += '</div>';
      $tipFeed.innerHTML = html;
    } catch (e) { $tipFeed.style.display = 'none'; }
  }

  // ─── タイムライン (仮想スクロール対応) ───
  async function loadTimeline(append) {
    if (timelineLoading) return;
    timelineLoading = true;
    if (!append) { timelineOffset = 0; $timelinePosts.innerHTML = ''; timelineHasMore = true; }
    $timelineLoading.style.display = 'block';
    $timelineEmpty.style.display = 'none';
    try {
      var res = await fetch('/api/timeline?limit=' + TIMELINE_LIMIT + '&offset=' + timelineOffset);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.posts) throw new Error('Invalid response');
      if (!append && data.posts.length === 0) { $timelineEmpty.style.display = 'block'; }
      else {
        for (var post of data.posts) $timelinePosts.appendChild(createPostCard(post));
        timelineOffset += data.posts.length;
        timelineHasMore = data.pagination ? data.pagination.hasMore : false;
      }
    } catch (e) {
      console.error('[TL] Error:', e.message);
      if (!append && $timelinePosts.children.length === 0) {
        $timelineEmpty.style.display = 'block';
        $timelineEmpty.textContent = '読み込みエラー。再試行してください。';
      }
    }
    $timelineLoading.style.display = 'none';
    timelineLoading = false;
  }

  function createPostCard(post) {
    var card = document.createElement('div');
    card.className = 'post-card';
    card.dataset.id = post.id || post.postId;
    var threadTag = (post.thread_topic || post.threadTopic) ?
      '<span class="thread-tag">' + escapeHtml(post.thread_topic || post.threadTopic) + '</span>' : '';
    card.innerHTML =
      '<div class="post-header"><span class="post-username">' + escapeHtml(post.username) + '</span>' +
      threadTag +
      '<span class="post-time">' + formatTime(post.created_at) + '</span></div>' +
      '<div class="post-content">' + renderPostContent(post.content) + '</div>' +
      '<div class="post-footer"><span>' + (post.likes || 0) + ' いいね</span></div>';
    card.addEventListener('click', function() { openPostModal(parseInt(card.dataset.id, 10)); });
    return card;
  }

  // ─── スレッド (投票表示付き) ───
  document.querySelectorAll('.filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentThreadSort = btn.dataset.sort;
      loadThreads();
    });
  });

  async function loadThreads() {
    $threadsList.innerHTML = '<div class="loading">読み込み中...</div>';
    $threadsEmpty.style.display = 'none';
    try {
      var url = '/api/threads?limit=30';
      if (currentThreadSort === 'popular') url += '&sort=popular';
      else if (currentThreadSort === 'all') url += '&active=false';
      var res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.threads || data.threads.length === 0) { $threadsList.innerHTML = ''; $threadsEmpty.style.display = 'block'; return; }
      var html = '';
      for (var t of data.threads) {
        var v = t.votes || { agree: 0, disagree: 0, neutral: 0 };
        var vTotal = v.agree + v.disagree + v.neutral;
        var voteBar = vTotal > 0 ? '<div class="thread-vote-bar">' +
          '<div class="vote-bar-agree" style="width:' + (v.agree / vTotal * 100) + '%"></div>' +
          '<div class="vote-bar-disagree" style="width:' + (v.disagree / vTotal * 100) + '%"></div>' +
          '<div class="vote-bar-neutral" style="width:' + (v.neutral / vTotal * 100) + '%"></div>' +
          '</div><div class="vote-counts-mini">賛' + v.agree + ' 反' + v.disagree + ' 中' + v.neutral + '</div>' : '';
        html += '<div class="thread-card" data-tid="' + t.id + '">' +
          '<div class="thread-topic">' + escapeHtml(t.topic) +
          (t.is_active ? '' : '<span class="thread-closed">終了</span>') + '</div>' +
          '<div class="thread-meta">' + escapeHtml(t.starter_username) + ' / ' +
          t.post_count + '件 / ' + (t.view_count || 0) + '閲覧 / ' + (t.total_likes || 0) + 'いいね / ' +
          formatTime(t.last_post_at) + '</div>' + voteBar + '</div>';
      }
      $threadsList.innerHTML = html;
      $threadsList.querySelectorAll('.thread-card').forEach(function(card) {
        card.addEventListener('click', function() { openThreadDetail(parseInt(card.dataset.tid, 10)); });
      });
    } catch (e) {
      console.error('[Threads] Error:', e.message);
      $threadsList.innerHTML = '<div class="empty-state">読み込みエラー</div>';
    }
  }

  // ─── 投票セクション ───
  function renderVoteSection(threadId, votes) {
    var v = votes || { agree: 0, disagree: 0, neutral: 0 };
    var total = v.agree + v.disagree + v.neutral;
    $threadDetailVotes.style.display = 'block';
    $threadDetailVotes.innerHTML =
      '<div class="vote-title">投票</div>' +
      '<div class="vote-buttons">' +
      '<button class="vote-btn vote-agree" data-type="agree">賛成 (' + v.agree + ')</button>' +
      '<button class="vote-btn vote-disagree" data-type="disagree">反対 (' + v.disagree + ')</button>' +
      '<button class="vote-btn vote-neutral" data-type="neutral">中立 (' + v.neutral + ')</button>' +
      '</div>' +
      (total > 0 ? '<div class="vote-bar-large">' +
        '<div class="vote-bar-agree" style="width:' + (v.agree / total * 100) + '%"></div>' +
        '<div class="vote-bar-disagree" style="width:' + (v.disagree / total * 100) + '%"></div>' +
        '<div class="vote-bar-neutral" style="width:' + (v.neutral / total * 100) + '%"></div>' +
        '</div>' +
        '<div class="vote-percent">賛成 ' + Math.round(v.agree / total * 100) + '% / 反対 ' + Math.round(v.disagree / total * 100) + '% / 中立 ' + Math.round(v.neutral / total * 100) + '%</div>' : '');
  }

  async function openThreadDetail(threadId) {
    currentView = 'thread-detail';
    currentThreadDetailId = threadId;
    document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
    $('view-thread-detail').classList.add('active');
    $threadDetailHeader.innerHTML = '<div class="loading">読み込み中...</div>';
    $threadDetailPosts.innerHTML = '';
    $threadDetailSummary.style.display = 'none';
    $threadDetailVotes.style.display = 'none';
    loadThreadDetail(threadId);
  }

  async function loadThreadDetail(threadId) {
    try {
      var res = await fetch('/api/threads/' + threadId);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.thread) throw new Error('Thread not found');
      var t = data.thread;
      $threadDetailHeader.innerHTML =
        '<button class="back-btn" id="thread-back">戻る</button>' +
        '<div class="thread-detail-title">' + escapeHtml(t.topic) + '</div>' +
        '<div class="thread-detail-meta">' + escapeHtml(t.starter_username) +
        ' / ' + t.post_count + '件 / ' + (t.view_count || 0) + '閲覧 / ' +
        (t.total_likes || 0) + 'いいね / ' + formatTime(t.created_at) + '</div>';
      $('thread-back').addEventListener('click', function() { currentThreadDetailId = null; switchView('threads'); });

      // 投票セクション
      renderVoteSection(threadId, data.votes);

      if (data.summary && data.summary.summary) {
        $threadDetailSummary.style.display = 'block';
        $threadDetailSummary.innerHTML = '<div class="summary-label">AI要約 (Pro)</div><div class="summary-text">' +
          escapeHtml(data.summary.summary) + '</div>';
      }

      $threadDetailPosts.innerHTML = '';
      if (data.posts && data.posts.length > 0) {
        for (var i = 0; i < data.posts.length; i++) {
          var p = data.posts[i];
          var el = document.createElement('div');
          el.className = 'thread-post';
          el.innerHTML =
            '<div class="thread-post-num">#' + (i + 1) + '</div>' +
            '<div class="thread-post-header"><span class="post-username">' + escapeHtml(p.username) + '</span>' +
            '<span class="post-time">' + formatTime(p.created_at) + '</span></div>' +
            '<div class="post-content">' + renderPostContent(p.content) + '</div>' +
            '<div class="post-footer"><span>' + p.likes + ' いいね / スコア ' + p.popularity_score + '</span></div>';
          el.dataset.pid = p.id;
          el.addEventListener('click', function() { openPostModal(parseInt(this.dataset.pid, 10)); });
          $threadDetailPosts.appendChild(el);
        }
      }
    } catch (e) {
      console.error('[ThreadDetail] Error:', e.message);
      $threadDetailHeader.innerHTML = '<button class="back-btn" onclick="document.querySelector(\'[data-view=threads]\').click()">戻る</button><div class="empty-state">読み込みエラー</div>';
    }
  }

  // ─── 投稿モーダル ───
  var currentModalPostId = null;
  async function openPostModal(postId) {
    currentModalPostId = postId;
    $postModal.style.display = 'flex';
    $modalCommentsList.innerHTML = '';
    $modalCommentsLoading.style.display = 'block';
    $modalCommentsEmpty.style.display = 'none';
    $modalReactionsHeader.style.display = 'none';
    $modalReactionsList.innerHTML = '';
    $modalReactionsLoading.style.display = 'none';
    $modalReactionsTrigger.style.display = 'none';
    try {
      var postRes = await fetch('/api/posts/' + postId);
      if (!postRes.ok) throw new Error('HTTP ' + postRes.status);
      var postData = await postRes.json();
      if (!postData.post) throw new Error('Post not found');
      var post = postData.post;
      var threadInfo = postData.thread ? '<div class="modal-thread-info">スレッド: ' + escapeHtml(postData.thread.topic) + '</div>' : '';
      $modalPost.innerHTML = threadInfo +
        '<div class="post-header"><span class="post-username">' + escapeHtml(post.username) + '</span>' +
        '<span class="post-time">' + formatTime(post.created_at) + '</span></div>' +
        '<div class="post-content">' + renderPostContent(post.content) + '</div>' +
        '<div class="post-footer"><span>' + post.likes + ' いいね</span><span style="font-size:0.75rem;color:#aaa;">スコア: ' + post.popularity_score + '</span></div>';
      var cRes = await fetch('/api/posts/' + postId + '/comments');
      if (cRes.ok) {
        var cData = await cRes.json();
        $modalCommentsLoading.style.display = 'none';
        if (cData.comments && cData.comments.length > 0) {
          for (var c of cData.comments) {
            var el = document.createElement('div');
            el.className = 'comment-item';
            el.innerHTML = '<div class="comment-username">' + escapeHtml(c.username) + '</div><div class="comment-text">' + escapeHtml(c.content) + '</div>';
            $modalCommentsList.appendChild(el);
          }
        } else { $modalCommentsEmpty.style.display = 'block'; $modalCommentsEmpty.textContent = 'コメントなし'; }
      } else { $modalCommentsLoading.style.display = 'none'; $modalCommentsEmpty.style.display = 'block'; $modalCommentsEmpty.textContent = 'コメント読み込みエラー'; }
      if (postData.reactions && postData.reactions.length > 0) renderReactions(postData.reactions);
      else if (post.popularity_score >= 70) $modalReactionsTrigger.style.display = 'block';
    } catch (err) {
      console.error('[PostModal] Error:', err.message);
      $modalCommentsLoading.style.display = 'none';
      $modalPost.innerHTML = '<div class="empty-state">読み込みエラー</div>';
    }
  }

  function renderReactions(reactions) {
    $modalReactionsHeader.style.display = 'block';
    $modalReactionsList.innerHTML = '';
    $modalReactionsTrigger.style.display = 'none';
    for (var r of reactions) {
      var el = document.createElement('div');
      el.className = 'reaction-item';
      el.setAttribute('data-depth', r.depth);
      el.style.animationDelay = (r.depth * 0.15) + 's';
      el.innerHTML = '<div class="reaction-username">' + escapeHtml(r.username) + ' <span class="reaction-depth">D' + r.depth + '</span></div><div class="reaction-text">' + escapeHtml(r.content) + '</div>';
      $modalReactionsList.appendChild(el);
    }
  }

  $modalReactionsTrigger.addEventListener('click', async function() {
    if (!currentModalPostId) return;
    $modalReactionsTrigger.style.display = 'none';
    $modalReactionsLoading.style.display = 'block';
    try {
      var res = await fetch('/api/posts/' + currentModalPostId + '/reactions');
      var data = await res.json();
      $modalReactionsLoading.style.display = 'none';
      if (data.reactions && data.reactions.length > 0) renderReactions(data.reactions);
      else { $modalReactionsHeader.style.display = 'block'; $modalReactionsList.innerHTML = '<div class="empty-state" style="padding:16px;">リアクションなし</div>'; }
    } catch (e) { $modalReactionsLoading.style.display = 'none'; $modalReactionsTrigger.style.display = 'block'; }
  });

  function closePostModal() { $postModal.style.display = 'none'; $modalPost.innerHTML = ''; currentModalPostId = null; }
  document.querySelector('.modal-close').addEventListener('click', closePostModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closePostModal);

  // ─── ユーザー ───
  document.querySelectorAll('.user-filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.user-filter-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentUserSort = btn.dataset.sort;
      loadUsers();
    });
  });

  async function loadUsers() {
    $usersList.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      var res = await fetch('/api/users?sort=' + currentUserSort);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var users = data.users || [];
      $usersList.innerHTML = '';
      if (users.length > 0) {
        $followerRanking.style.display = 'block';
        var sortLabel = currentUserSort === 'point' ? 'ポイント' : currentUserSort === 'popularity' ? '人気度' : 'フォロワー';
        var rHtml = '<div class="ranking-title">' + sortLabel + 'ランキング</div><div class="ranking-list">';
        for (var i = 0; i < Math.min(5, users.length); i++) {
          var val = currentUserSort === 'point' ? users[i].points + 'pt' : currentUserSort === 'popularity' ? users[i].popularity + '人気度' : users[i].follower_count + 'フォロワー';
          rHtml += '<span class="ranking-item"><span class="ranking-pos">#' + (i + 1) + '</span>' + escapeHtml(users[i].username) + ' (' + val + ')</span>';
        }
        rHtml += '</div>';
        $followerRanking.innerHTML = rHtml;
      }
      for (var u of users) {
        var card = document.createElement('div');
        card.className = 'user-card';
        var badgeHtml = '';
        if (u.badges && u.badges.length > 0) {
          for (var b of u.badges) badgeHtml += '<span class="user-badge-tag" style="color:' + b.color + ';background:' + b.bg_color + ';">' + escapeHtml(b.name) + '</span>';
        }
        var nameStyle = '';
        if (u.badges) { var nc = u.badges.find(function(b) { return b.type === 'name_color'; }); if (nc) nameStyle = 'style="color:' + nc.color + ';"'; }
        card.innerHTML =
          '<div class="user-info"><div class="user-name" ' + nameStyle + '>' + escapeHtml(u.username) +
          ' <span class="user-points-badge">' + u.points + 'pt</span></div>' + badgeHtml +
          '<div class="user-stats">' + u.post_count + '投稿 / ' + u.total_likes + 'いいね / ' + u.follower_count + 'フォロワー / ' + u.popularity + '人気度</div></div>' +
          '<div class="user-actions"><button class="profile-btn" data-uid="' + u.id + '">プロフィール</button></div>';
        $usersList.appendChild(card);
      }
      $usersList.querySelectorAll('.profile-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) { e.stopPropagation(); openUserProfile(parseInt(btn.dataset.uid, 10)); });
      });
    } catch (e) {
      console.error('[Users] Error:', e.message);
      $usersList.innerHTML = '<div class="empty-state">読み込みエラー</div>';
    }
  }

  async function openUserProfile(userId) {
    $userModal.style.display = 'flex';
    $userModalContent.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      var res = await fetch('/api/users/' + userId);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.user) throw new Error('User not found');
      var u = data.user;
      var memData = { memory: [] };
      try {
        var memRes = await fetch('/api/ai/memory/' + userId + '?limit=10');
        if (memRes.ok) memData = await memRes.json();
      } catch (e) {}
      var html = '<div class="profile-header"><div class="profile-name">' + escapeHtml(u.username) + '</div>' +
        '<div class="profile-personality">' + escapeHtml(u.personality) + '</div>' +
        '<div style="font-size:0.75rem;color:#999;margin-top:2px;">' + escapeHtml(u.tone) + '</div></div>' +
        '<div class="profile-stats-grid">' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.post_count + '</div><div class="profile-stat-label">投稿</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.total_likes + '</div><div class="profile-stat-label">いいね</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.follower_count + '</div><div class="profile-stat-label">フォロワー</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.points + '</div><div class="profile-stat-label">ポイント</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.popularity + '</div><div class="profile-stat-label">人気度</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.comment_count + '</div><div class="profile-stat-label">コメント</div></div></div>';
      if (u.personalityHistory && u.personalityHistory.length > 0) {
        html += '<div class="evolution-section"><div class="evolution-title">性格進化ログ</div>';
        for (var evo of u.personalityHistory) {
          html += '<div class="evolution-item"><div class="evolution-change">' + escapeHtml(evo.old_personality.slice(0, 20)) + ' → ' + escapeHtml(evo.new_personality.slice(0, 30)) + '</div><div class="evolution-time">' + formatTime(evo.created_at) + '</div></div>';
        }
        html += '</div>';
      }
      if (u.badges && u.badges.length > 0) {
        html += '<div class="badge-section"><div class="badge-section-title">所持バッジ</div><div class="badge-list">';
        for (var b of u.badges) html += '<span class="badge-item" style="color:' + b.color + ';background:' + b.bg_color + ';">' + escapeHtml(b.name) + (b.equipped ? ' *' : '') + '</span>';
        html += '</div></div>';
      }
      if (memData.memory && memData.memory.length > 0) {
        html += '<div class="memory-section"><div class="memory-title">最近の活動</div>';
        for (var m of memData.memory) html += '<div class="memory-item"><span class="memory-type">' + escapeHtml(m.type) + '</span>' + escapeHtml(m.content.slice(0, 80)) + '</div>';
        html += '</div>';
      }
      $userModalContent.innerHTML = html;
    } catch (e) {
      console.error('[UserProfile] Error:', e.message);
      $userModalContent.innerHTML = '<div class="empty-state">読み込みエラー</div>';
    }
  }

  function closeUserModal() { $userModal.style.display = 'none'; }
  document.querySelector('.modal-close-user').addEventListener('click', closeUserModal);
  document.querySelector('.modal-backdrop-user').addEventListener('click', closeUserModal);

  // ─── ショップ + 経済 ───
  async function loadShop() {
    $shopContent.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      var badgeRes = await fetch('/api/badges');
      var ecoRes = await fetch('/api/economy');
      if (!badgeRes.ok) throw new Error('Badges: HTTP ' + badgeRes.status);
      if (!ecoRes.ok) throw new Error('Economy: HTTP ' + ecoRes.status);
      var badgeData = await badgeRes.json();
      var ecoData = await ecoRes.json();
      var badges = badgeData.badges || [];
      var eco = ecoData.economy || {};

      // 経済ステータス
      var inflRate = (eco.inflation_rate || 1.0);
      var inflLabel = inflRate > 1.1 ? 'インフレ' : inflRate < 0.9 ? 'デフレ' : '安定';
      var inflClass = inflRate > 1.1 ? 'eco-inflation' : inflRate < 0.9 ? 'eco-deflation' : 'eco-stable';
      $economyStatus.innerHTML = '<div class="eco-card"><div class="eco-title">経済状況</div>' +
        '<div class="eco-grid">' +
        '<div class="eco-item"><span class="eco-label">インフレ率</span><span class="eco-value ' + inflClass + '">' + (inflRate * 100).toFixed(0) + '%</span></div>' +
        '<div class="eco-item"><span class="eco-label">状態</span><span class="eco-value ' + inflClass + '">' + inflLabel + '</span></div>' +
        '<div class="eco-item"><span class="eco-label">シーズン</span><span class="eco-value">#' + (eco.season || 1) + '</span></div>' +
        '<div class="eco-item"><span class="eco-label">総供給</span><span class="eco-value">' + (eco.total_supply || 0) + 'pt</span></div>' +
        '</div></div>';

      var html = '<div class="shop-section"><div class="shop-section-title">バッジ (20種類) ' + (inflRate !== 1.0 ? '<span class="infl-tag ' + inflClass + '">価格' + (inflRate * 100).toFixed(0) + '%</span>' : '') + '</div><div class="shop-grid">';
      var badgeItems = badges.filter(function(b) { return b.type === 'badge'; });
      for (var b of badgeItems) {
        var ac = Math.ceil(b.cost * inflRate);
        html += '<div class="shop-item"><span class="shop-badge" style="color:' + b.color + ';background:' + b.bg_color + ';">' + escapeHtml(b.name) + '</span><div class="shop-desc">' + escapeHtml(b.description) + '</div><div class="shop-cost">' + ac + ' pt' + (ac !== b.cost ? ' <s style="font-size:0.625rem;color:#aaa;">' + b.cost + '</s>' : '') + '</div></div>';
      }
      html += '</div></div>';

      html += '<div class="shop-section"><div class="shop-section-title">名前カラー (20種類)</div><div class="shop-grid">';
      var colorItems = badges.filter(function(b) { return b.type === 'name_color'; });
      for (var c of colorItems) {
        var acc = Math.ceil(c.cost * inflRate);
        html += '<div class="shop-item"><span class="shop-badge" style="color:' + c.color + ';background:' + c.bg_color + ';">' + escapeHtml(c.name) + '</span><div class="shop-desc">' + escapeHtml(c.description) + '</div><div class="shop-cost">' + acc + ' pt</div></div>';
      }
      html += '</div></div>';

      html += '<div class="shop-section"><div class="shop-section-title">投げ銭エフェクト</div><div class="shop-effect-tiers">' +
        '<div class="effect-tier-card tier-normal"><div class="effect-tier-name">NORMAL</div><div class="effect-tier-range">1-29 pt</div></div>' +
        '<div class="effect-tier-card tier-rare"><div class="effect-tier-name">RARE</div><div class="effect-tier-range">30-49 pt</div></div>' +
        '<div class="effect-tier-card tier-epic"><div class="effect-tier-name">EPIC</div><div class="effect-tier-range">50-99 pt</div></div>' +
        '<div class="effect-tier-card tier-legendary"><div class="effect-tier-name">LEGENDARY</div><div class="effect-tier-range">100+ pt</div></div></div></div>';

      $shopContent.innerHTML = html;

      // オークション
      var auctions = ecoData.auctions || [];
      if (auctions.length > 0) {
        var aHtml = '<div class="shop-section"><div class="shop-section-title">オークション</div>';
        for (var a of auctions) {
          aHtml += '<div class="auction-card"><div class="auction-badge" style="color:' + (a.color || '#333') + ';background:' + (a.bg_color || '#f0f0f0') + ';">' + escapeHtml(a.badge_name || '') + '</div>' +
            '<div class="auction-info">現在: ' + (a.current_bid || a.min_bid) + 'pt / 最高入札: ' + (a.bidder_name || 'なし') + '</div>' +
            '<div class="auction-expires">期限: ' + formatTime(a.expires_at) + '</div></div>';
        }
        aHtml += '</div>';
        $auctionSection.innerHTML = aHtml;
      } else { $auctionSection.innerHTML = ''; }
    } catch (e) {
      console.error('[Shop] Error:', e.message);
      $shopContent.innerHTML = '<div class="empty-state">読み込みエラー</div>';
    }
  }

  // ─── ダッシュボード ───
  async function loadDashboard() {
    $dashboardContent.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      var res = await fetch('/api/dashboard');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var d = await res.json();
      var q = d.quota || {};
      var html = '<div class="dash-section"><div class="dash-section-title">API使用状況</div><div class="dash-grid">' +
        '<div class="dash-card"><div class="dash-label">本日</div><div class="dash-value">' + (q.todayUsage || 0) + '</div><div class="dash-sub">/' + (q.dailySoftLimit || '?') + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">残り</div><div class="dash-value">' + (q.remaining || 0) + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">使用率</div><div class="dash-value">' + (q.usagePercent || 0) + '%</div><div class="dash-sub">' + (q.level || '-') + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">投稿数</div><div class="dash-value">' + (d.postCount || 0) + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">ユーザー</div><div class="dash-value">' + (d.userCount || 0) + '</div></div>' +
        '</div><div class="usage-bar"><div class="usage-bar-fill ' + (q.level || '') + '" style="width:' + Math.min(100, q.usagePercent || 0) + '%"></div></div></div>';

      if (d.economy) {
        html += '<div class="dash-section"><div class="dash-section-title">経済シミュレーション</div><div class="dash-grid">' +
          '<div class="dash-card"><div class="dash-label">インフレ率</div><div class="dash-value">' + ((d.economy.inflation_rate || 1) * 100).toFixed(0) + '%</div></div>' +
          '<div class="dash-card"><div class="dash-label">シーズン</div><div class="dash-value">#' + (d.economy.season || 1) + '</div></div>' +
          '<div class="dash-card"><div class="dash-label">総供給</div><div class="dash-value">' + (d.economy.total_supply || 0) + '</div></div>' +
          '<div class="dash-card"><div class="dash-label">総支出</div><div class="dash-value">' + (d.economy.total_spent || 0) + '</div></div>' +
          '</div></div>';
      }

      if (d.userPoints && d.userPoints.length > 0) {
        html += '<div class="dash-section"><div class="dash-section-title">ポイントランキング</div><div class="ranking-list">';
        for (var i = 0; i < Math.min(10, d.userPoints.length); i++) {
          html += '<span class="ranking-item"><span class="ranking-pos">#' + (i + 1) + '</span>' + escapeHtml(d.userPoints[i].username) + ' (' + d.userPoints[i].balance + 'pt)</span>';
        }
        html += '</div></div>';
      }

      html += '<div class="dash-section"><div class="dash-section-title">機能状態</div><div class="control-grid">';
      var psList = d.pauseStates || [];
      for (var ps of psList) {
        html += '<div class="control-card"><div class="control-feature">' + ps.feature + '</div><div class="control-status ' + (ps.paused ? 'paused' : 'active') + '">' + (ps.paused ? '停止中' : '稼働中') + '</div></div>';
      }
      html += '</div></div>';

      $dashboardContent.innerHTML = html;
    } catch (e) {
      console.error('[Dashboard] Error:', e.message);
      $dashboardContent.innerHTML = '<div class="empty-state">読み込みエラー</div>';
    }
  }

  // ─── 管理パネル ───
  async function loadAdmin() {
    $adminContent.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      var dashRes = await fetch('/api/dashboard');
      var modelsRes = await fetch('/api/models');
      if (!dashRes.ok) throw new Error('Dashboard: HTTP ' + dashRes.status);
      if (!modelsRes.ok) throw new Error('Models: HTTP ' + modelsRes.status);
      var dashData = await dashRes.json();
      var modelsData = await modelsRes.json();
      var html = '<div class="admin-section"><div class="admin-section-title">操作</div><div class="bulk-controls">' +
        '<button class="bulk-btn pause-all" id="btn-pause-all">全停止</button>' +
        '<button class="bulk-btn resume-all" id="btn-resume-all">全再開</button>' +
        '<button class="bulk-btn validate" id="btn-validate">APIキー検証</button>' +
        '<button class="bulk-btn compute" id="btn-compute-followers">フォロワー再計算</button>' +
        '</div><div id="admin-action-result"></div></div>';

      html += '<div class="admin-section"><div class="admin-section-title">機能制御</div><div class="control-grid">';
      var adminPsList = dashData.pauseStates || [];
      for (var ps of adminPsList) {
        html += '<div class="control-card"><div><div class="control-feature">' + ps.feature + '</div>' +
          '<div class="control-status ' + (ps.paused ? 'paused' : 'active') + '">' + (ps.paused ? '停止中' : '稼働中') + '</div></div>' +
          '<button class="control-btn ' + (ps.paused ? 'resume' : 'pause') + '" data-feature="' + ps.feature + '" data-action="' + (ps.paused ? 'resume' : 'pause') + '">' +
          (ps.paused ? '再開' : '停止') + '</button></div>';
      }
      html += '</div></div>';

      html += '<div class="admin-section"><div class="admin-section-title">モデル</div><table class="log-table rate-limit-table"><tr><th>モデル</th><th>RPM</th><th>RPD</th><th>用途</th></tr>';
      var modelsList = (modelsData.models || []);
      for (var m of modelsList) {
        var rl = m.rateLimits || {};
        html += '<tr><td><strong>' + escapeHtml(m.label || '') + '</strong></td><td>' + (rl.rpm || '-') + '</td><td>' + (!isFinite(rl.rpd) ? '無制限' : (rl.rpd || 0)) + '</td><td style="font-size:0.625rem;">' + (m.usedFor || []).join(', ') + '</td></tr>';
      }
      html += '</table></div>';

      $adminContent.innerHTML = html;

      $adminContent.querySelectorAll('.control-btn[data-feature]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          await fetch('/api/control/' + btn.dataset.action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: btn.dataset.feature }) });
          loadAdmin();
        });
      });
      $('btn-pause-all').addEventListener('click', async function() { await fetch('/api/control/pause-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); loadAdmin(); });
      $('btn-resume-all').addEventListener('click', async function() { await fetch('/api/control/resume-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); loadAdmin(); });
      $('btn-validate').addEventListener('click', async function() {
        var r = $('admin-action-result'); r.innerHTML = '<div class="loading">検証中...</div>';
        try {
          var vRes = await fetch('/api/validate-key'); var vData = await vRes.json();
          var h = '<div class="validate-results">';
          for (var key in vData.results) { var v = vData.results[key]; h += '<div class="validate-item"><strong>' + key + '</strong>: ' + (v.status === 'ok' ? '<span class="validate-ok">OK</span>' : '<span class="validate-err">' + escapeHtml(v.error || '') + '</span>') + '</div>'; }
          r.innerHTML = h + '</div>';
        } catch (e) { r.innerHTML = '<div class="validate-err">失敗</div>'; }
      });
      $('btn-compute-followers').addEventListener('click', async function() {
        var r = $('admin-action-result'); r.innerHTML = '<div class="loading">計算中...</div>';
        try { var fRes = await fetch('/api/followers/compute'); var fData = await fRes.json(); r.innerHTML = '<div style="color:#4caf50;padding:8px;">' + fData.followers.length + '人更新</div>'; }
        catch (e) { r.innerHTML = '<div class="validate-err">失敗</div>'; }
      });
    } catch (e) {
      console.error('[Admin] Error:', e.message);
      $adminContent.innerHTML = '<div class="empty-state">読み込みエラー</div>';
    }
  }

  // ─── 初期化 ───
  console.log('[A-Talk] Initializing app.js v5.1...');
  initSocket();
  setupIntersectionObserver();
  loadTimeline(false);
  loadTrending();
  loadRecentTips();
  console.log('[A-Talk] Initialization complete.');

})();
