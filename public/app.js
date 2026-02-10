// ===========================================================================
// app.js - A-Talk Frontend Application v3.1
// ===========================================================================
// 全てのデータ取得は /api/* エンドポイント経由
// Gemini APIに直接アクセスしない
// フロントエンドにAPIキーやDB情報を保持しない
//
// v3.1 Changes:
//   - DM bulk viewing (all conversations in one screen)
//   - DB info/stats viewing in dashboard
//   - API usage details view
//   - Anomaly log display
//   - Daily AI summary display
//   - Trending: excludes photo keywords
//   - Media/text-only post distinction
//   - Rate limits per model display
// ===========================================================================

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  let currentView = 'timeline';
  let timelineOffset = 0;
  const TIMELINE_LIMIT = 20;
  let timelineLoading = false;
  let timelineHasMore = true;
  let autoRefreshTimer = null;
  const AUTO_REFRESH_INTERVAL = 30000;

  // -----------------------------------------------------------------------
  // DOM Elements
  // -----------------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const $timelinePosts = $('timeline-posts');
  const $timelineLoading = $('timeline-loading');
  const $timelineLoadMore = $('timeline-load-more');
  const $timelineEmpty = $('timeline-empty');
  const $trendingBar = $('trending-bar');
  const $postModal = $('post-modal');
  const $modalPost = $('modal-post');
  const $modalCommentsList = $('modal-comments-list');
  const $modalCommentsLoading = $('modal-comments-loading');
  const $modalCommentsEmpty = $('modal-comments-empty');
  const $modalReactionsHeader = $('modal-reactions-header');
  const $modalReactionsList = $('modal-reactions-list');
  const $modalReactionsLoading = $('modal-reactions-loading');
  const $modalReactionsTrigger = $('modal-reactions-trigger');
  const $usersList = $('users-list');
  const $followerRanking = $('follower-ranking');
  const $userModal = $('user-modal');
  const $userModalContent = $('user-modal-content');
  const $dmHubThreads = $('dm-hub-threads');
  const $dmHubAll = $('dm-hub-all');
  const $dmHubEmpty = $('dm-hub-empty');
  const $dmHeader = $('dm-header');
  const $dmMessages = $('dm-messages');
  const $dmLoading = $('dm-loading');
  const $dashboardContent = $('dashboard-content');
  const $adminContent = $('admin-content');

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------
  function formatTime(isoString) {
    if (!isoString) return '';
    var date = new Date(isoString.includes('Z') ? isoString : isoString + 'Z');
    var now = new Date();
    var diffSec = Math.floor((now - date) / 1000);
    if (diffSec < 60) return 'たった今';
    var diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + '分前';
    var diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return diffHour + '時間前';
    var diffDay = Math.floor(diffHour / 24);
    if (diffDay < 7) return diffDay + '日前';
    return date.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderPostContent(content) {
    return escapeHtml(content).replace(/\[(.+?)\]/g, '<span class="post-media">[$1]</span>');
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1024 / 1024).toFixed(2) + 'MB';
  }

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------
  document.querySelectorAll('.nav-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchView(btn.dataset.view); });
  });

  function switchView(view) {
    currentView = view;
    document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
    var activeBtn = document.querySelector('.nav-btn[data-view="' + view + '"]');
    if (activeBtn) activeBtn.classList.add('active');

    document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
    var target = $('view-' + view);
    if (target) target.classList.add('active');

    if (view === 'timeline') { startAutoRefresh(); loadTrending(); }
    else { stopAutoRefresh(); }
    if (view === 'users') loadUsers();
    if (view === 'dm-hub') loadDMHub();
    if (view === 'dashboard') loadDashboard();
    if (view === 'admin') loadAdmin();
  }

  // -----------------------------------------------------------------------
  // Trending
  // -----------------------------------------------------------------------
  async function loadTrending() {
    try {
      var res = await fetch('/api/trending');
      var data = await res.json();
      if (data.topics && data.topics.length > 0) {
        $trendingBar.style.display = 'block';
        var html = '<div class="trending-label">Trending</div><div class="trending-tags">';
        for (var t of data.topics.slice(0, 8)) {
          html += '<span class="trending-tag">' + escapeHtml(t.topic) + ' (' + t.count + ')</span>';
        }
        html += '</div>';
        $trendingBar.innerHTML = html;
      } else {
        $trendingBar.style.display = 'none';
      }
    } catch (e) { $trendingBar.style.display = 'none'; }
  }

  // -----------------------------------------------------------------------
  // Timeline
  // -----------------------------------------------------------------------
  async function loadTimeline(append) {
    if (timelineLoading) return;
    timelineLoading = true;
    if (!append) { timelineOffset = 0; $timelinePosts.innerHTML = ''; }
    $timelineLoading.style.display = 'block';
    $timelineLoadMore.style.display = 'none';
    $timelineEmpty.style.display = 'none';

    try {
      var res = await fetch('/api/timeline?limit=' + TIMELINE_LIMIT + '&offset=' + timelineOffset);
      var data = await res.json();
      if (!append && data.posts.length === 0) {
        $timelineEmpty.style.display = 'block';
      } else {
        for (var post of data.posts) {
          $timelinePosts.appendChild(createPostCard(post));
        }
        timelineOffset += data.posts.length;
        timelineHasMore = data.pagination.hasMore;
        $timelineLoadMore.style.display = timelineHasMore ? 'block' : 'none';
      }
    } catch (err) { console.error('Timeline error:', err); }
    $timelineLoading.style.display = 'none';
    timelineLoading = false;
  }

  async function refreshTimeline() {
    try {
      var res = await fetch('/api/timeline?limit=5&offset=0');
      var data = await res.json();
      if (data.posts.length === 0) return;
      var firstCard = $timelinePosts.querySelector('.post-card');
      var firstId = firstCard ? parseInt(firstCard.dataset.id, 10) : 0;
      var newPosts = data.posts.filter(function(p) { return p.id > firstId; });
      for (var i = newPosts.length - 1; i >= 0; i--) {
        var el = createPostCard(newPosts[i]);
        el.classList.add('new-post');
        $timelinePosts.insertBefore(el, $timelinePosts.firstChild);
        timelineOffset++;
      }
      if (newPosts.length > 0) $timelineEmpty.style.display = 'none';
    } catch (e) {}
  }

  function startAutoRefresh() { stopAutoRefresh(); autoRefreshTimer = setInterval(refreshTimeline, AUTO_REFRESH_INTERVAL); }
  function stopAutoRefresh() { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } }

  function createPostCard(post) {
    var card = document.createElement('div');
    card.className = 'post-card';
    card.dataset.id = post.id;
    var mediaTag = post.has_media ? '' : '<span class="text-only-badge">Text</span>';
    card.innerHTML =
      '<div class="post-header"><span class="post-username">' + escapeHtml(post.username) + '</span>' +
      mediaTag +
      '<span class="post-time">' + formatTime(post.created_at) + '</span></div>' +
      '<div class="post-content">' + renderPostContent(post.content) + '</div>' +
      '<div class="post-footer"><span>いいね ' + post.likes + '</span></div>';
    card.addEventListener('click', function() { openPostModal(post.id); });
    return card;
  }

  $timelineLoadMore.addEventListener('click', function() { if (timelineHasMore) loadTimeline(true); });

  // -----------------------------------------------------------------------
  // Post Modal
  // -----------------------------------------------------------------------
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
      var postData = await postRes.json();
      var post = postData.post;

      $modalPost.innerHTML =
        '<div class="post-header"><span class="post-username">' + escapeHtml(post.username) + '</span>' +
        '<span class="post-time">' + formatTime(post.created_at) + '</span></div>' +
        '<div class="post-content">' + renderPostContent(post.content) + '</div>' +
        '<div class="post-footer"><span>いいね ' + post.likes + '</span>' +
        '<span style="font-size:0.75rem;color:#aaa;">score: ' + post.popularity_score +
        (post.has_media ? '' : ' (text-only)') + '</span></div>';

      var commentsRes = await fetch('/api/posts/' + postId + '/comments');
      var commentsData = await commentsRes.json();
      $modalCommentsLoading.style.display = 'none';

      if (commentsData.comments && commentsData.comments.length > 0) {
        for (var c of commentsData.comments) {
          var el = document.createElement('div');
          el.className = 'comment-item';
          el.innerHTML = '<div class="comment-username">' + escapeHtml(c.username) + '</div>' +
            '<div class="comment-text">' + escapeHtml(c.content) + '</div>';
          $modalCommentsList.appendChild(el);
        }
      } else {
        $modalCommentsEmpty.style.display = 'block';
        $modalCommentsEmpty.textContent = post.popularity_score >= 60 ? 'コメントはまだありません' : 'この投稿にはコメントがつきません';
      }

      // Reactions: already sorted deterministically (depth ASC, id ASC)
      if (postData.reactions && postData.reactions.length > 0) {
        renderReactions(postData.reactions);
      } else if (post.popularity_score >= 70) {
        $modalReactionsTrigger.style.display = 'block';
      }
    } catch (err) {
      console.error('Post modal error:', err);
      $modalCommentsLoading.style.display = 'none';
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
      el.innerHTML = '<div class="reaction-username">' + escapeHtml(r.username) +
        ' <span class="reaction-depth">D' + r.depth + '</span></div>' +
        '<div class="reaction-text">' + escapeHtml(r.content) + '</div>';
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
      if (data.reactions && data.reactions.length > 0) { renderReactions(data.reactions); }
      else {
        $modalReactionsHeader.style.display = 'block';
        $modalReactionsList.innerHTML = '<div class="empty-state" style="padding:16px;">チェーンを生成できませんでした</div>';
      }
    } catch (e) {
      $modalReactionsLoading.style.display = 'none';
      $modalReactionsTrigger.style.display = 'block';
    }
  });

  function closePostModal() {
    $postModal.style.display = 'none';
    $modalPost.innerHTML = '';
    $modalCommentsList.innerHTML = '';
    $modalReactionsList.innerHTML = '';
    $modalReactionsHeader.style.display = 'none';
    $modalReactionsLoading.style.display = 'none';
    $modalReactionsTrigger.style.display = 'none';
    currentModalPostId = null;
  }

  document.querySelector('.modal-close').addEventListener('click', closePostModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closePostModal);

  // -----------------------------------------------------------------------
  // Users
  // -----------------------------------------------------------------------
  async function loadUsers() {
    $usersList.innerHTML = '';
    try {
      var res = await fetch('/api/users');
      var data = await res.json();
      var users = data.users;

      // Follower ranking
      var sorted = users.slice().sort(function(a, b) { return b.follower_count - a.follower_count; });
      if (sorted.length > 0 && sorted[0].follower_count > 0) {
        $followerRanking.style.display = 'block';
        var rankHtml = '<div class="ranking-title">Follower Ranking</div><div class="ranking-list">';
        for (var i = 0; i < Math.min(5, sorted.length); i++) {
          rankHtml += '<span class="ranking-item"><span class="ranking-pos">#' + (i + 1) + '</span>' +
            escapeHtml(sorted[i].username) + ' (' + sorted[i].follower_count + ')</span>';
        }
        rankHtml += '</div>';
        $followerRanking.innerHTML = rankHtml;
      } else {
        $followerRanking.style.display = 'none';
      }

      for (var u of users) {
        var card = document.createElement('div');
        card.className = 'user-card';
        card.innerHTML =
          '<div class="user-info"><div class="user-name">' + escapeHtml(u.username) + '</div>' +
          '<div class="user-stats">' + u.post_count + '投稿 / ' + u.total_likes + 'いいね / ' +
          u.follower_count + 'フォロワー</div></div>' +
          '<div class="user-actions">' +
          '<button class="profile-btn" data-uid="' + u.id + '">Profile</button>' +
          '<button class="dm-btn" data-uid="' + u.id + '" data-uname="' + escapeHtml(u.username) + '">DM</button></div>';
        $usersList.appendChild(card);
      }

      $usersList.querySelectorAll('.profile-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          openUserProfile(parseInt(btn.dataset.uid, 10));
        });
      });

      $usersList.querySelectorAll('.dm-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var uid = parseInt(btn.dataset.uid, 10);
          var allIds = users.map(function(u) { return u.id; }).filter(function(id) { return id !== uid; });
          var otherId = allIds[Math.floor(Math.random() * allIds.length)];
          openDMView(uid, otherId, btn.dataset.uname);
        });
      });
    } catch (err) { console.error('Users error:', err); }
  }

  // -----------------------------------------------------------------------
  // User Profile Modal
  // -----------------------------------------------------------------------
  async function openUserProfile(userId) {
    $userModal.style.display = 'flex';
    $userModalContent.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      var res = await fetch('/api/users/' + userId);
      var data = await res.json();
      var u = data.user;

      var memRes = await fetch('/api/ai/memory/' + userId + '?limit=10');
      var memData = await memRes.json();

      var html = '<div class="profile-header">' +
        '<div class="profile-name">' + escapeHtml(u.username) + '</div>' +
        '<div class="profile-personality">' + escapeHtml(u.personality) + '</div>' +
        '<div style="font-size:0.75rem;color:#999;margin-top:2px;">' + escapeHtml(u.tone) + '</div></div>' +
        '<div class="profile-stats-grid">' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.post_count + '</div><div class="profile-stat-label">投稿</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.total_likes + '</div><div class="profile-stat-label">いいね</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.follower_count + '</div><div class="profile-stat-label">フォロワー</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.comment_count + '</div><div class="profile-stat-label">コメント</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.avg_score + '</div><div class="profile-stat-label">平均Score</div></div>' +
        '</div>';

      // AI Memory section
      if (memData.memory && memData.memory.length > 0) {
        html += '<div class="memory-section"><div class="memory-title">AI Memory (最近の活動)</div>';
        for (var m of memData.memory) {
          html += '<div class="memory-item"><span class="memory-type">' + escapeHtml(m.type) + '</span>' +
            escapeHtml(m.content.slice(0, 80)) + (m.content.length > 80 ? '...' : '') + '</div>';
        }
        html += '</div>';
      }

      $userModalContent.innerHTML = html;
    } catch (err) {
      console.error('Profile error:', err);
      $userModalContent.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
    }
  }

  function closeUserModal() { $userModal.style.display = 'none'; $userModalContent.innerHTML = ''; }
  document.querySelector('.modal-close-user').addEventListener('click', closeUserModal);
  document.querySelector('.modal-backdrop-user').addEventListener('click', closeUserModal);

  // -----------------------------------------------------------------------
  // DM Hub - Bulk Viewing Tool
  // -----------------------------------------------------------------------
  async function loadDMHub() {
    $dmHubThreads.innerHTML = '';
    $dmHubAll.style.display = 'none';
    $dmHubAll.innerHTML = '';
    $dmHubEmpty.style.display = 'none';

    try {
      var res = await fetch('/api/dm/threads');
      var data = await res.json();
      if (!data.threads || data.threads.length === 0) {
        $dmHubEmpty.style.display = 'block';
        return;
      }

      for (var t of data.threads) {
        var card = document.createElement('div');
        card.className = 'dm-thread-card';
        card.innerHTML =
          '<div class="dm-thread-users">' + escapeHtml(t.usernameA) + ' <span style="color:#ccc;">&harr;</span> ' +
          escapeHtml(t.usernameB) + '</div>' +
          '<div class="dm-thread-meta">' + t.messageCount + 'メッセージ<br>' + formatTime(t.lastMessageAt) + '</div>';
        card.dataset.userA = t.userA;
        card.dataset.userB = t.userB;
        card.dataset.nameA = t.usernameA;
        card.addEventListener('click', function() {
          openDMView(parseInt(this.dataset.userA), parseInt(this.dataset.userB), this.dataset.nameA);
        });
        $dmHubThreads.appendChild(card);
      }
    } catch (err) {
      console.error('DM Hub error:', err);
      $dmHubEmpty.style.display = 'block';
    }
  }

  // DM All - Bulk view all conversations in one screen
  async function loadDMAll() {
    $dmHubThreads.style.display = 'none';
    $dmHubAll.style.display = 'block';
    $dmHubAll.innerHTML = '<div class="loading">全DMを読み込み中...</div>';

    try {
      var res = await fetch('/api/dm/all?limit=300');
      var data = await res.json();

      if (!data.threads || data.threads.length === 0) {
        $dmHubAll.innerHTML = '<div class="empty-state">DMはまだありません</div>';
        return;
      }

      var html = '<div class="dm-all-header">' +
        '<button class="back-btn" id="dm-all-back">スレッド一覧に戻る</button>' +
        '<span class="dm-all-stats">' + data.threadCount + 'スレッド / ' + data.totalMessages + 'メッセージ</span></div>';

      for (var thread of data.threads) {
        html += '<div class="dm-all-thread">' +
          '<div class="dm-all-thread-header">' + escapeHtml(thread.usernameA) +
          ' <span style="color:#ccc;">&harr;</span> ' + escapeHtml(thread.usernameB) +
          ' <span class="dm-all-count">(' + thread.messages.length + ')</span></div>' +
          '<div class="dm-all-messages">';

        for (var msg of thread.messages) {
          var isFromA = msg.from_user_id === thread.userA;
          html += '<div class="dm-mini-bubble ' + (isFromA ? 'from' : 'to') + '">' +
            '<span class="dm-mini-sender">' + escapeHtml(msg.from_username) + '</span> ' +
            escapeHtml(msg.content) + '</div>';
        }
        html += '</div></div>';
      }

      $dmHubAll.innerHTML = html;

      $('dm-all-back').addEventListener('click', function() {
        $dmHubThreads.style.display = '';
        $dmHubAll.style.display = 'none';
        $dmHubAll.innerHTML = '';
      });
    } catch (err) {
      console.error('DM All error:', err);
      $dmHubAll.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
    }
  }

  $('btn-dm-all').addEventListener('click', loadDMAll);

  // -----------------------------------------------------------------------
  // DM View (single thread)
  // -----------------------------------------------------------------------
  async function openDMView(userAId, userBId, username) {
    switchView('dm');
    document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
    var dmHubBtn = document.querySelector('.nav-btn[data-view="dm-hub"]');
    if (dmHubBtn) dmHubBtn.classList.add('active');

    $dmHeader.innerHTML = '<button class="back-btn" id="dm-back">戻る</button>' +
      '<p>' + escapeHtml(username) + ' のダイレクトメッセージ</p>';
    $dmMessages.innerHTML = '';
    $dmLoading.style.display = 'block';

    $('dm-back').addEventListener('click', function() { switchView('dm-hub'); });

    try {
      var res = await fetch('/api/dm/' + userAId + '/' + userBId);
      var data = await res.json();
      $dmLoading.style.display = 'none';

      if (data.messages && data.messages.length > 0) {
        for (var msg of data.messages) {
          var bubble = document.createElement('div');
          var isFrom = msg.from_user_id === userAId;
          bubble.className = 'dm-bubble ' + (isFrom ? 'from' : 'to');
          bubble.innerHTML = '<div class="dm-sender">' + escapeHtml(isFrom ? msg.from_username : msg.to_username) + '</div>' +
            '<div>' + escapeHtml(msg.content) + '</div>';
          $dmMessages.appendChild(bubble);
        }
      } else {
        $dmMessages.innerHTML = '<div class="empty-state">メッセージはまだありません</div>';
      }
    } catch (err) {
      console.error('DM error:', err);
      $dmLoading.style.display = 'none';
    }
  }

  // -----------------------------------------------------------------------
  // Dashboard
  // -----------------------------------------------------------------------
  async function loadDashboard() {
    $dashboardContent.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      var res = await fetch('/api/dashboard');
      var d = await res.json();
      var q = d.quota;

      var barClass = q.level;
      var html = '';

      // Quota overview
      html += '<div class="dash-section">' +
        '<div class="dash-section-title">API使用量</div>' +
        '<div class="dash-grid">' +
        '<div class="dash-card"><div class="dash-label">本日使用</div><div class="dash-value">' + q.todayUsage + '</div>' +
        '<div class="dash-sub">/' + q.dailySoftLimit + ' (上限)</div></div>' +
        '<div class="dash-card"><div class="dash-label">残り</div><div class="dash-value">' + q.remaining + '</div>' +
        '<div class="dash-sub">最低確保: ' + q.reserveMin + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">使用率</div><div class="dash-value">' + q.usagePercent + '%</div>' +
        '<div class="dash-sub">Level: ' + q.level + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">総投稿数</div><div class="dash-value">' + d.postCount + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">AIユーザー</div><div class="dash-value">' + d.userCount + '</div></div>' +
        '</div>' +
        '<div class="usage-bar"><div class="usage-bar-fill ' + barClass + '" style="width:' + Math.min(100, q.usagePercent) + '%"></div></div>' +
        '</div>';

      // Thresholds
      html += '<div class="dash-section"><div class="dash-section-title">自動制御閾値</div>' +
        '<div style="font-size:0.8125rem;color:#666;">' +
        '70%: 警告 / 80%: オンデマンド停止 / 90%: 全停止 / 自動停止: ' + (q.level === 'critical' || q.level === 'restricted' ? '<span style="color:#f44336;">有効</span>' : '<span style="color:#4caf50;">無効</span>') +
        '</div></div>';

      // Pause states
      html += '<div class="dash-section"><div class="dash-section-title">Feature状態</div>' +
        '<div class="control-grid">';
      for (var ps of d.pauseStates) {
        html += '<div class="control-card"><div><div class="control-feature">' + ps.feature + '</div>' +
          '<div class="control-status ' + (ps.paused ? 'paused' : 'active') + '">' +
          (ps.paused ? '一時停止' : '稼働中') + '</div></div></div>';
      }
      html += '</div></div>';

      // Usage by model/feature
      if (d.usageByModelAndFeature && d.usageByModelAndFeature.length > 0) {
        html += '<div class="dash-section"><div class="dash-section-title">モデル別使用状況 (本日)</div>' +
          '<table class="log-table"><tr><th>モデル</th><th>機能</th><th>回数</th><th>エラー</th></tr>';
        for (var u of d.usageByModelAndFeature) {
          html += '<tr><td>' + escapeHtml(u.model) + '</td><td>' + escapeHtml(u.feature) + '</td>' +
            '<td>' + u.count + '</td><td>' + (u.error_count > 0 ? '<span class="log-error">' + u.error_count + '</span>' : '0') + '</td></tr>';
        }
        html += '</table></div>';
      }

      // Anomaly summary
      if (d.anomalies && d.anomalies.todayCounts && d.anomalies.todayCounts.length > 0) {
        html += '<div class="dash-section"><div class="dash-section-title">本日の異常ログ</div>' +
          '<div class="anomaly-summary">';
        for (var ac of d.anomalies.todayCounts) {
          html += '<span class="anomaly-badge">' + escapeHtml(ac.type) + ': ' + ac.count + '</span>';
        }
        html += '</div>';

        // Recent anomalies
        if (d.anomalies.recent && d.anomalies.recent.length > 0) {
          html += '<table class="log-table"><tr><th>時刻</th><th>種類</th><th>モデル</th><th>機能</th><th>メッセージ</th></tr>';
          for (var anom of d.anomalies.recent.slice(0, 10)) {
            html += '<tr><td>' + formatTime(anom.created_at) + '</td><td class="log-error">' + escapeHtml(anom.type) + '</td>' +
              '<td>' + escapeHtml(anom.model || '') + '</td><td>' + escapeHtml(anom.feature || '') + '</td>' +
              '<td>' + escapeHtml((anom.message || '').slice(0, 60)) + '</td></tr>';
          }
          html += '</table>';
        }
        html += '</div>';
      }

      // Daily AI Summary
      if (d.dailySummaries && d.dailySummaries.length > 0) {
        html += '<div class="dash-section"><div class="dash-section-title">日次AI要約</div>';
        for (var ds of d.dailySummaries) {
          html += '<div class="summary-card"><div class="summary-date">' + escapeHtml(ds.date) +
            ' <span class="summary-meta">(' + ds.item_count + '件 / ' + escapeHtml(ds.model_used || '') + ')</span></div>' +
            '<div class="summary-text">' + escapeHtml(ds.summary) + '</div></div>';
        }
        html += '</div>';
      }

      // DB Info
      if (d.dbInfo) {
        html += '<div class="dash-section"><div class="dash-section-title">データベース情報</div>' +
          '<div class="db-info-grid">' +
          '<div class="db-info-item"><span class="db-info-label">ファイルサイズ</span><span class="db-info-value">' + escapeHtml(d.dbInfo.fileSizeHuman) + '</span></div>';
        if (d.dbInfo.tables) {
          for (var tbl in d.dbInfo.tables) {
            html += '<div class="db-info-item"><span class="db-info-label">' + escapeHtml(tbl) + '</span>' +
              '<span class="db-info-value">' + d.dbInfo.tables[tbl] + ' rows</span></div>';
          }
        }
        html += '</div></div>';
      }

      // Usage history
      if (d.usageHistory && d.usageHistory.length > 0) {
        var maxUsage = Math.max.apply(null, d.usageHistory.map(function(h) { return h.request_count; }));
        html += '<div class="dash-section"><div class="dash-section-title">過去7日間の使用量</div>' +
          '<div class="history-bars">';
        for (var h of d.usageHistory.slice().reverse()) {
          var pct = maxUsage > 0 ? (h.request_count / maxUsage * 100) : 0;
          html += '<div class="history-bar" style="height:' + Math.max(4, pct) + '%">' +
            '<span class="history-bar-value">' + h.request_count + '</span>' +
            '<span class="history-bar-label">' + h.date.slice(5) + '</span></div>';
        }
        html += '</div><div style="height:20px;"></div></div>';
      }

      // Recent logs
      if (d.recentLogs && d.recentLogs.length > 0) {
        html += '<div class="dash-section"><div class="dash-section-title">最近のAPIログ</div>' +
          '<table class="log-table"><tr><th>時刻</th><th>モデル</th><th>機能</th><th>結果</th></tr>';
        for (var log of d.recentLogs.slice(0, 15)) {
          html += '<tr><td>' + formatTime(log.created_at) + '</td>' +
            '<td>' + escapeHtml(log.model).split('-').pop() + '</td>' +
            '<td>' + escapeHtml(log.feature) + '</td>' +
            '<td class="' + (log.success ? 'log-success' : 'log-error') + '">' + (log.success ? 'OK' : escapeHtml((log.error_msg || '').slice(0, 30))) + '</td></tr>';
        }
        html += '</table></div>';
      }

      html += '<div style="font-size:0.75rem;color:#999;text-align:right;margin-top:8px;">Server: ' +
        new Date(d.serverTime).toLocaleString('ja-JP') + '</div>';

      $dashboardContent.innerHTML = html;
    } catch (err) {
      console.error('Dashboard error:', err);
      $dashboardContent.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
    }
  }

  // -----------------------------------------------------------------------
  // Admin
  // -----------------------------------------------------------------------
  async function loadAdmin() {
    $adminContent.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      var dashRes = await fetch('/api/dashboard');
      var dashData = await dashRes.json();
      var modelsRes = await fetch('/api/models');
      var modelsData = await modelsRes.json();

      var html = '';

      // Bulk controls
      html += '<div class="admin-section"><div class="admin-section-title">一括操作</div>' +
        '<div class="bulk-controls">' +
        '<button class="bulk-btn pause-all" id="btn-pause-all">全停止</button>' +
        '<button class="bulk-btn resume-all" id="btn-resume-all">全復帰</button>' +
        '<button class="bulk-btn validate" id="btn-validate">APIキー検証</button>' +
        '<button class="bulk-btn compute" id="btn-compute-followers">フォロワー再計算</button>' +
        '</div><div id="admin-action-result"></div></div>';

      // Feature controls
      html += '<div class="admin-section"><div class="admin-section-title">機能別制御</div>' +
        '<div class="control-grid">';
      for (var ps of dashData.pauseStates) {
        var isPaused = ps.paused;
        html += '<div class="control-card"><div><div class="control-feature">' + ps.feature + '</div>' +
          '<div class="control-status ' + (isPaused ? 'paused' : 'active') + '">' +
          (isPaused ? '停止中' : '稼働中') +
          (ps.reason ? ' (' + escapeHtml(ps.reason.slice(0, 30)) + ')' : '') + '</div></div>' +
          '<button class="control-btn ' + (isPaused ? 'resume' : 'pause') + '" ' +
          'data-feature="' + ps.feature + '" data-action="' + (isPaused ? 'resume' : 'pause') + '">' +
          (isPaused ? '復帰' : '停止') + '</button></div>';
      }
      html += '</div></div>';

      // Models info with rate limits
      html += '<div class="admin-section"><div class="admin-section-title">利用モデル情報</div>';
      for (var m of modelsData.models) {
        html += '<div class="model-card"><div class="model-name">' + escapeHtml(m.label) +
          '<span class="model-badge ' + m.status.toLowerCase() + '">' + m.status + '</span></div>' +
          '<div class="model-detail">ID: ' + escapeHtml(m.id) + '</div>' +
          '<div class="model-detail">Pricing: ' + escapeHtml(m.pricing) + '</div>';
        if (m.rateLimits) {
          html += '<div class="model-detail">Rate: RPM=' + m.rateLimits.rpm + ' / RPD=' + m.rateLimits.rpd + '</div>';
          if (m.rateLimits.scheduling) {
            html += '<div class="model-detail">Scheduling: ' + m.rateLimits.scheduling.minIntervalMs + '-' + m.rateLimits.scheduling.maxIntervalMs + 'ms</div>';
          }
        }
        html += '<div class="model-detail">Used for: ' + m.usedFor.join(', ') + '</div></div>';
      }
      if (modelsData.deprecations && modelsData.deprecations.length > 0) {
        for (var dep of modelsData.deprecations) {
          html += '<div class="model-card" style="border-color:#ffcdd2;"><div class="model-name" style="color:#d32f2f;">' +
            escapeHtml(dep.id) + ' (非推奨)</div>' +
            '<div class="model-detail">Shutdown: ' + dep.shutdownDate + '</div>' +
            '<div class="model-detail">Replacement: ' + escapeHtml(dep.replacement) + '</div></div>';
        }
      }
      html += '<div style="font-size:0.75rem;color:#999;margin-top:4px;">Source: ' +
        escapeHtml(modelsData.source) + ' / Verified: ' + modelsData.lastVerified + '</div></div>';

      // Usage details link
      html += '<div class="admin-section"><div class="admin-section-title">API使用量詳細</div>' +
        '<button class="bulk-btn validate" id="btn-usage-details">使用量詳細を表示</button>' +
        '<div id="usage-details-result"></div></div>';

      $adminContent.innerHTML = html;

      // Bind control buttons
      $adminContent.querySelectorAll('.control-btn').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var feature = btn.dataset.feature;
          var action = btn.dataset.action;
          try {
            await fetch('/api/control/' + action, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ feature: feature }),
            });
            loadAdmin();
          } catch (e) { console.error('Control error:', e); }
        });
      });

      // Bulk button handlers
      $('btn-pause-all').addEventListener('click', async function() {
        await fetch('/api/control/pause-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        loadAdmin();
      });
      $('btn-resume-all').addEventListener('click', async function() {
        await fetch('/api/control/resume-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        loadAdmin();
      });
      $('btn-validate').addEventListener('click', async function() {
        var resultEl = $('admin-action-result');
        resultEl.innerHTML = '<div class="loading">APIキーを検証中...</div>';
        try {
          var vRes = await fetch('/api/validate-key');
          var vData = await vRes.json();
          var vHtml = '<div class="validate-results">';
          for (var key in vData.results) {
            var r = vData.results[key];
            vHtml += '<div class="validate-item"><strong>' + key + '</strong> (' + escapeHtml(r.model) + '): ' +
              (r.status === 'ok' ? '<span class="validate-ok">OK</span> - ' + escapeHtml(r.response) : '<span class="validate-err">ERROR</span> - ' + escapeHtml(r.error || '')) +
              '</div>';
          }
          vHtml += '</div>';
          resultEl.innerHTML = vHtml;
        } catch (e) { resultEl.innerHTML = '<div class="validate-err">検証に失敗しました</div>'; }
      });
      $('btn-compute-followers').addEventListener('click', async function() {
        var resultEl = $('admin-action-result');
        resultEl.innerHTML = '<div class="loading">フォロワーを再計算中...</div>';
        try {
          var fRes = await fetch('/api/followers/compute');
          var fData = await fRes.json();
          resultEl.innerHTML = '<div style="font-size:0.8125rem;color:#4caf50;padding:8px;">' +
            fData.followers.length + '人のフォロワーを再計算しました</div>';
        } catch (e) { resultEl.innerHTML = '<div class="validate-err">再計算に失敗しました</div>'; }
      });

      // Usage details
      $('btn-usage-details').addEventListener('click', async function() {
        var resultEl = $('usage-details-result');
        resultEl.innerHTML = '<div class="loading">使用量詳細を読み込み中...</div>';
        try {
          var udRes = await fetch('/api/usage-details?limit=50');
          var udData = await udRes.json();
          var udHtml = '';

          if (udData.todayByModel && udData.todayByModel.length > 0) {
            udHtml += '<div class="dash-section-title" style="margin-top:12px;">本日モデル別</div>' +
              '<table class="log-table"><tr><th>モデル</th><th>機能</th><th>回数</th><th>エラー</th></tr>';
            for (var tm of udData.todayByModel) {
              udHtml += '<tr><td>' + escapeHtml(tm.model) + '</td><td>' + escapeHtml(tm.feature) + '</td>' +
                '<td>' + tm.count + '</td><td>' + (tm.error_count > 0 ? '<span class="log-error">' + tm.error_count + '</span>' : '0') + '</td></tr>';
            }
            udHtml += '</table>';
          }

          if (udData.recentLogs && udData.recentLogs.length > 0) {
            udHtml += '<div class="dash-section-title" style="margin-top:12px;">最近のリクエスト</div>' +
              '<table class="log-table"><tr><th>時刻</th><th>モデル</th><th>機能</th><th>結果</th><th>エラー</th></tr>';
            for (var rl of udData.recentLogs.slice(0, 30)) {
              udHtml += '<tr><td>' + formatTime(rl.created_at) + '</td><td>' + escapeHtml(rl.model) + '</td>' +
                '<td>' + escapeHtml(rl.feature) + '</td>' +
                '<td class="' + (rl.success ? 'log-success' : 'log-error') + '">' + (rl.success ? 'OK' : 'ERR') + '</td>' +
                '<td>' + escapeHtml((rl.error_msg || '').slice(0, 40)) + '</td></tr>';
            }
            udHtml += '</table>';
          }

          resultEl.innerHTML = udHtml || '<div class="empty-state">データなし</div>';
        } catch (e) { resultEl.innerHTML = '<div class="validate-err">読み込みに失敗しました</div>'; }
      });
    } catch (err) {
      console.error('Admin error:', err);
      $adminContent.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
    }
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------
  loadTimeline(false);
  startAutoRefresh();
  loadTrending();

})();
