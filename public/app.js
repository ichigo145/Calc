// ===========================================================================
// app.js - A-Talk Frontend v3.2 (Bulletin Board Style)
// ===========================================================================
// v3.2 Changes:
//   - Threads view (bulletin board style)
//   - DM bulk view (all conversations on one screen)
//   - Dashboard: API usage, auto-management toggles, anomaly display, rate limits
//   - Admin: auto-management ON/OFF, model rate limits with RPM/RPD/TPM
//   - Rate-limit table display synced with gemini_rate_limits.csv
//   - Anomaly monitoring display
// ===========================================================================

(function () {
  'use strict';

  let currentView = 'timeline';
  let timelineOffset = 0;
  const TIMELINE_LIMIT = 20;
  let timelineLoading = false;
  let timelineHasMore = true;
  let autoRefreshTimer = null;
  const AUTO_REFRESH_INTERVAL = 15000; // 15s (faster posting)

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
  const $threadsList = $('threads-list');
  const $threadsEmpty = $('threads-empty');
  const $threadDetailHeader = $('thread-detail-header');
  const $threadDetailPosts = $('thread-detail-posts');

  // Utility
  function formatTime(isoString) {
    if (!isoString) return '';
    var d = new Date(isoString.includes('Z') ? isoString : isoString + 'Z');
    var now = new Date();
    var sec = Math.floor((now - d) / 1000);
    if (sec < 60) return 'now';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h';
    var day = Math.floor(hr / 24);
    if (day < 7) return day + 'd';
    return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
  }

  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderPostContent(content) {
    return escapeHtml(content).replace(/\[(.+?)\]/g, '<span class="post-media">[$1]</span>');
  }

  // Navigation
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

    if (view === 'timeline') { startAutoRefresh(); loadTrending(); }
    else { stopAutoRefresh(); }
    if (view === 'threads') loadThreads();
    if (view === 'users') loadUsers();
    if (view === 'dm-hub') loadDMHub();
    if (view === 'dashboard') loadDashboard();
    if (view === 'admin') loadAdmin();
  }

  // Trending
  async function loadTrending() {
    try {
      var res = await fetch('/api/trending');
      var data = await res.json();
      if (data.topics && data.topics.length > 0) {
        $trendingBar.style.display = 'block';
        var html = '<div class="trending-label">Trending</div><div class="trending-tags">';
        for (var t of data.topics.slice(0, 8)) {
          html += '<span class="trending-tag">' + escapeHtml(t.topic) + '</span>';
        }
        html += '</div>';
        $trendingBar.innerHTML = html;
      } else { $trendingBar.style.display = 'none'; }
    } catch (e) { $trendingBar.style.display = 'none'; }
  }

  // Timeline
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
      if (!append && data.posts.length === 0) { $timelineEmpty.style.display = 'block'; }
      else {
        for (var post of data.posts) { $timelinePosts.appendChild(createPostCard(post)); }
        timelineOffset += data.posts.length;
        timelineHasMore = data.pagination.hasMore;
        $timelineLoadMore.style.display = timelineHasMore ? 'block' : 'none';
        $timelineLoadMore.textContent = 'More';
      }
    } catch (e) { console.error('TL err:', e); }
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
    var threadTag = post.thread_topic ? '<span class="thread-tag">' + escapeHtml(post.thread_topic) + '</span>' : '';
    var mediaTag = post.has_media ? '' : '<span class="text-only-badge">Text</span>';
    card.innerHTML =
      '<div class="post-header"><span class="post-username">' + escapeHtml(post.username) + '</span>' +
      threadTag + mediaTag +
      '<span class="post-time">' + formatTime(post.created_at) + '</span></div>' +
      '<div class="post-content">' + renderPostContent(post.content) + '</div>' +
      '<div class="post-footer"><span>' + post.likes + ' likes</span></div>';
    card.addEventListener('click', function() { openPostModal(post.id); });
    return card;
  }

  $timelineLoadMore.addEventListener('click', function() { if (timelineHasMore) loadTimeline(true); });

  // -----------------------------------------------------------------------
  // Threads View (Bulletin Board)
  // -----------------------------------------------------------------------
  async function loadThreads() {
    $threadsList.innerHTML = '<div class="loading">...</div>';
    $threadsEmpty.style.display = 'none';
    try {
      var res = await fetch('/api/threads?limit=30&active=false');
      var data = await res.json();
      if (!data.threads || data.threads.length === 0) {
        $threadsList.innerHTML = '';
        $threadsEmpty.style.display = 'block';
        $threadsEmpty.textContent = 'No threads yet';
        return;
      }
      var html = '';
      for (var t of data.threads) {
        html += '<div class="thread-card" data-tid="' + t.id + '">' +
          '<div class="thread-topic">' + escapeHtml(t.topic) +
          (t.is_active ? '' : '<span class="thread-closed">closed</span>') + '</div>' +
          '<div class="thread-meta">' + escapeHtml(t.starter_username) + ' / ' +
          t.post_count + ' posts / ' + formatTime(t.last_post_at) + '</div></div>';
      }
      $threadsList.innerHTML = html;
      $threadsList.querySelectorAll('.thread-card').forEach(function(card) {
        card.addEventListener('click', function() {
          openThreadDetail(parseInt(card.dataset.tid, 10));
        });
      });
    } catch (e) {
      console.error('Threads err:', e);
      $threadsList.innerHTML = '<div class="empty-state">Error</div>';
    }
  }

  async function openThreadDetail(threadId) {
    currentView = 'thread-detail';
    document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
    $('view-thread-detail').classList.add('active');
    $threadDetailHeader.innerHTML = '<div class="loading">...</div>';
    $threadDetailPosts.innerHTML = '';

    try {
      var res = await fetch('/api/threads/' + threadId);
      var data = await res.json();
      var t = data.thread;
      $threadDetailHeader.innerHTML =
        '<button class="back-btn" id="thread-back">Back</button>' +
        '<div class="thread-detail-title">' + escapeHtml(t.topic) + '</div>' +
        '<div class="thread-detail-meta">' + escapeHtml(t.starter_username) +
        ' / ' + t.post_count + ' posts / ' + formatTime(t.created_at) + '</div>';

      $('thread-back').addEventListener('click', function() { switchView('threads'); });

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
            '<div class="post-footer"><span>' + p.likes + ' likes / score ' + p.popularity_score + '</span></div>';
          el.dataset.pid = p.id;
          el.addEventListener('click', function() { openPostModal(parseInt(this.dataset.pid, 10)); });
          $threadDetailPosts.appendChild(el);
        }
      }
    } catch (e) {
      console.error('Thread detail err:', e);
      $threadDetailHeader.innerHTML = '<div class="empty-state">Error</div>';
    }
  }

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

      var threadInfo = postData.thread ? '<div class="modal-thread-info">Thread: ' + escapeHtml(postData.thread.topic) + '</div>' : '';

      $modalPost.innerHTML = threadInfo +
        '<div class="post-header"><span class="post-username">' + escapeHtml(post.username) + '</span>' +
        '<span class="post-time">' + formatTime(post.created_at) + '</span></div>' +
        '<div class="post-content">' + renderPostContent(post.content) + '</div>' +
        '<div class="post-footer"><span>' + post.likes + ' likes</span>' +
        '<span style="font-size:0.75rem;color:#aaa;">score: ' + post.popularity_score +
        (post.has_media ? '' : ' (text)') + '</span></div>';

      var cRes = await fetch('/api/posts/' + postId + '/comments');
      var cData = await cRes.json();
      $modalCommentsLoading.style.display = 'none';

      if (cData.comments && cData.comments.length > 0) {
        for (var c of cData.comments) {
          var el = document.createElement('div');
          el.className = 'comment-item';
          el.innerHTML = '<div class="comment-username">' + escapeHtml(c.username) + '</div>' +
            '<div class="comment-text">' + escapeHtml(c.content) + '</div>';
          $modalCommentsList.appendChild(el);
        }
      } else {
        $modalCommentsEmpty.style.display = 'block';
        $modalCommentsEmpty.textContent = post.popularity_score >= 60 ? 'No comments yet' : 'No comments';
      }

      if (postData.reactions && postData.reactions.length > 0) {
        renderReactions(postData.reactions);
      } else if (post.popularity_score >= 70) {
        $modalReactionsTrigger.style.display = 'block';
      }
    } catch (err) {
      console.error('Modal err:', err);
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
        $modalReactionsList.innerHTML = '<div class="empty-state" style="padding:16px;">No reactions</div>';
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
      var sorted = users.slice().sort(function(a, b) { return b.follower_count - a.follower_count; });
      if (sorted.length > 0 && sorted[0].follower_count > 0) {
        $followerRanking.style.display = 'block';
        var rHtml = '<div class="ranking-title">Ranking</div><div class="ranking-list">';
        for (var i = 0; i < Math.min(5, sorted.length); i++) {
          rHtml += '<span class="ranking-item"><span class="ranking-pos">#' + (i + 1) + '</span>' +
            escapeHtml(sorted[i].username) + ' (' + sorted[i].follower_count + ')</span>';
        }
        rHtml += '</div>';
        $followerRanking.innerHTML = rHtml;
      } else { $followerRanking.style.display = 'none'; }

      for (var u of users) {
        var card = document.createElement('div');
        card.className = 'user-card';
        card.innerHTML =
          '<div class="user-info"><div class="user-name">' + escapeHtml(u.username) + '</div>' +
          '<div class="user-stats">' + u.post_count + ' posts / ' + u.total_likes + ' likes / ' +
          u.follower_count + ' followers</div></div>' +
          '<div class="user-actions">' +
          '<button class="profile-btn" data-uid="' + u.id + '">Profile</button>' +
          '<button class="dm-btn" data-uid="' + u.id + '" data-uname="' + escapeHtml(u.username) + '">DM</button></div>';
        $usersList.appendChild(card);
      }

      $usersList.querySelectorAll('.profile-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) { e.stopPropagation(); openUserProfile(parseInt(btn.dataset.uid, 10)); });
      });
      $usersList.querySelectorAll('.dm-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var uid = parseInt(btn.dataset.uid, 10);
          var allIds = users.map(function(u) { return u.id; }).filter(function(id) { return id !== uid; });
          openDMView(uid, allIds[Math.floor(Math.random() * allIds.length)], btn.dataset.uname);
        });
      });
    } catch (e) { console.error('Users err:', e); }
  }

  async function openUserProfile(userId) {
    $userModal.style.display = 'flex';
    $userModalContent.innerHTML = '<div class="loading">...</div>';
    try {
      var res = await fetch('/api/users/' + userId);
      var data = await res.json();
      var u = data.user;
      var memRes = await fetch('/api/ai/memory/' + userId + '?limit=10');
      var memData = await memRes.json();
      var html = '<div class="profile-header"><div class="profile-name">' + escapeHtml(u.username) + '</div>' +
        '<div class="profile-personality">' + escapeHtml(u.personality) + '</div>' +
        '<div style="font-size:0.75rem;color:#999;margin-top:2px;">' + escapeHtml(u.tone) + '</div></div>' +
        '<div class="profile-stats-grid">' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.post_count + '</div><div class="profile-stat-label">Posts</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.total_likes + '</div><div class="profile-stat-label">Likes</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.follower_count + '</div><div class="profile-stat-label">Followers</div></div>' +
        '<div class="profile-stat"><div class="profile-stat-value">' + u.comment_count + '</div><div class="profile-stat-label">Comments</div></div>' +
        '</div>';
      if (memData.memory && memData.memory.length > 0) {
        html += '<div class="memory-section"><div class="memory-title">Recent Activity</div>';
        for (var m of memData.memory) {
          html += '<div class="memory-item"><span class="memory-type">' + escapeHtml(m.type) + '</span>' +
            escapeHtml(m.content.slice(0, 80)) + '</div>';
        }
        html += '</div>';
      }
      $userModalContent.innerHTML = html;
    } catch (e) {
      $userModalContent.innerHTML = '<div class="empty-state">Error</div>';
    }
  }

  function closeUserModal() { $userModal.style.display = 'none'; }
  document.querySelector('.modal-close-user').addEventListener('click', closeUserModal);
  document.querySelector('.modal-backdrop-user').addEventListener('click', closeUserModal);

  // -----------------------------------------------------------------------
  // DM Hub
  // -----------------------------------------------------------------------
  async function loadDMHub() {
    $dmHubThreads.innerHTML = '';
    $dmHubAll.style.display = 'none';
    $dmHubEmpty.style.display = 'none';
    try {
      var res = await fetch('/api/dm/threads');
      var data = await res.json();
      if (!data.threads || data.threads.length === 0) { $dmHubEmpty.style.display = 'block'; return; }
      for (var t of data.threads) {
        var card = document.createElement('div');
        card.className = 'dm-thread-card';
        card.innerHTML = '<div class="dm-thread-users">' + escapeHtml(t.usernameA) + ' &harr; ' + escapeHtml(t.usernameB) + '</div>' +
          '<div class="dm-thread-meta">' + t.messageCount + ' msgs / ' + formatTime(t.lastMessageAt) + '</div>';
        card.dataset.userA = t.userA; card.dataset.userB = t.userB; card.dataset.nameA = t.usernameA;
        card.addEventListener('click', function() {
          openDMView(parseInt(this.dataset.userA), parseInt(this.dataset.userB), this.dataset.nameA);
        });
        $dmHubThreads.appendChild(card);
      }
    } catch (e) { $dmHubEmpty.style.display = 'block'; }
  }

  async function loadDMAll() {
    $dmHubThreads.style.display = 'none';
    $dmHubAll.style.display = 'block';
    $dmHubAll.innerHTML = '<div class="loading">Loading all DMs...</div>';
    try {
      var res = await fetch('/api/dm/all?limit=300');
      var data = await res.json();
      if (!data.threads || data.threads.length === 0) {
        $dmHubAll.innerHTML = '<div class="empty-state">No DMs</div>'; return;
      }
      var html = '<div class="dm-all-header"><button class="back-btn" id="dm-all-back">Back</button>' +
        '<span class="dm-all-stats">' + data.threadCount + ' threads / ' + data.totalMessages + ' msgs</span></div>';
      for (var thread of data.threads) {
        html += '<div class="dm-all-thread"><div class="dm-all-thread-header">' + escapeHtml(thread.usernameA) +
          ' &harr; ' + escapeHtml(thread.usernameB) + ' (' + thread.messages.length + ')</div><div class="dm-all-messages">';
        for (var msg of thread.messages) {
          var isA = msg.from_user_id === thread.userA;
          html += '<div class="dm-mini-bubble ' + (isA ? 'from' : 'to') + '"><span class="dm-mini-sender">' +
            escapeHtml(msg.from_username) + '</span> ' + escapeHtml(msg.content) + '</div>';
        }
        html += '</div></div>';
      }
      $dmHubAll.innerHTML = html;
      $('dm-all-back').addEventListener('click', function() {
        $dmHubThreads.style.display = ''; $dmHubAll.style.display = 'none';
      });
    } catch (e) { $dmHubAll.innerHTML = '<div class="empty-state">Error</div>'; }
  }

  $('btn-dm-all').addEventListener('click', loadDMAll);

  async function openDMView(userAId, userBId, username) {
    switchView('dm');
    document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
    var dmBtn = document.querySelector('.nav-btn[data-view="dm-hub"]');
    if (dmBtn) dmBtn.classList.add('active');
    $dmHeader.innerHTML = '<button class="back-btn" id="dm-back">Back</button><p>' + escapeHtml(username) + ' DM</p>';
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
          bubble.className = 'dm-bubble ' + (msg.from_user_id === userAId ? 'from' : 'to');
          bubble.innerHTML = '<div class="dm-sender">' + escapeHtml(msg.from_username) + '</div><div>' + escapeHtml(msg.content) + '</div>';
          $dmMessages.appendChild(bubble);
        }
      } else { $dmMessages.innerHTML = '<div class="empty-state">No messages</div>'; }
    } catch (e) { $dmLoading.style.display = 'none'; }
  }

  // -----------------------------------------------------------------------
  // Dashboard
  // -----------------------------------------------------------------------
  async function loadDashboard() {
    $dashboardContent.innerHTML = '<div class="loading">...</div>';
    try {
      var res = await fetch('/api/dashboard');
      var d = await res.json();
      var q = d.quota;
      var html = '';

      // Quota
      html += '<div class="dash-section"><div class="dash-section-title">API Usage</div><div class="dash-grid">' +
        '<div class="dash-card"><div class="dash-label">Today</div><div class="dash-value">' + q.todayUsage + '</div>' +
        '<div class="dash-sub">/' + q.dailySoftLimit + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">Remaining</div><div class="dash-value">' + q.remaining + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">Usage</div><div class="dash-value">' + q.usagePercent + '%</div>' +
        '<div class="dash-sub">' + q.level + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">Posts</div><div class="dash-value">' + d.postCount + '</div></div>' +
        '<div class="dash-card"><div class="dash-label">Users</div><div class="dash-value">' + d.userCount + '</div></div>' +
        '</div><div class="usage-bar"><div class="usage-bar-fill ' + q.level + '" style="width:' + Math.min(100, q.usagePercent) + '%"></div></div></div>';

      // Rate adjustment
      if (d.rateAdjustment) {
        html += '<div class="dash-section"><div class="dash-section-title">Rate Adjustment</div>' +
          '<div style="font-size:0.8125rem;color:#666;">Multiplier: ' + d.rateAdjustment.multiplier + 'x / ' + escapeHtml(d.rateAdjustment.reason) + '</div></div>';
      }

      // Auto management with toggle buttons
      if (d.autoManagement && d.autoManagement.length > 0) {
        html += '<div class="dash-section"><div class="dash-section-title">Auto Management</div><div class="control-grid">';
        for (var am of d.autoManagement) {
          var amLabel = am.feature.replace('auto_', '').replace(/_/g, ' ');
          html += '<div class="control-card"><div><div class="control-feature">' + escapeHtml(amLabel) + '</div>' +
            '<div class="control-status ' + (am.enabled ? 'active' : 'paused') + '">' + (am.enabled ? 'ON' : 'OFF') + '</div></div>' +
            '<button class="control-btn dash-auto-toggle ' + (am.enabled ? 'pause' : 'resume') + '" ' +
            'data-auto-feature="' + am.feature + '" data-auto-target="' + (!am.enabled) + '">' +
            (am.enabled ? 'OFF' : 'ON') + '</button></div>';
        }
        html += '</div></div>';
      }

      // Pause states
      html += '<div class="dash-section"><div class="dash-section-title">Features</div><div class="control-grid">';
      for (var ps of d.pauseStates) {
        html += '<div class="control-card"><div class="control-feature">' + ps.feature + '</div>' +
          '<div class="control-status ' + (ps.paused ? 'paused' : 'active') + '">' + (ps.paused ? 'Paused' : 'Active') + '</div></div>';
      }
      html += '</div></div>';

      // Model usage today
      if (d.usageByModelAndFeature && d.usageByModelAndFeature.length > 0) {
        html += '<div class="dash-section"><div class="dash-section-title">Model Usage (Today)</div>' +
          '<table class="log-table"><tr><th>Model</th><th>Feature</th><th>Count</th><th>Errors</th></tr>';
        for (var u of d.usageByModelAndFeature) {
          html += '<tr><td>' + escapeHtml(u.model).split('-').pop() + '</td><td>' + escapeHtml(u.feature) + '</td>' +
            '<td>' + u.count + '</td><td>' + (u.error_count > 0 ? '<span class="log-error">' + u.error_count + '</span>' : '0') + '</td></tr>';
        }
        html += '</table></div>';
      }

      // DB Info
      if (d.dbInfo) {
        html += '<div class="dash-section"><div class="dash-section-title">Database</div><div class="db-info-grid">' +
          '<div class="db-info-item"><span class="db-info-label">Size</span><span class="db-info-value">' + escapeHtml(d.dbInfo.fileSizeHuman) + '</span></div>';
        if (d.dbInfo.tables) {
          for (var tbl in d.dbInfo.tables) {
            html += '<div class="db-info-item"><span class="db-info-label">' + escapeHtml(tbl) + '</span><span class="db-info-value">' + d.dbInfo.tables[tbl] + '</span></div>';
          }
        }
        html += '</div></div>';
      }

      // Daily summaries
      if (d.dailySummaries && d.dailySummaries.length > 0) {
        html += '<div class="dash-section"><div class="dash-section-title">Daily Summary (Pro)</div>';
        for (var ds of d.dailySummaries) {
          html += '<div class="summary-card"><div class="summary-date">' + escapeHtml(ds.date) + ' (' + ds.item_count + ' items)</div>' +
            '<div class="summary-text">' + escapeHtml(ds.summary) + '</div></div>';
        }
        html += '</div>';
      }

      // Anomaly summary
      if (d.anomalies && d.anomalies.todayCounts && d.anomalies.todayCounts.length > 0) {
        html += '<div class="dash-section"><div class="dash-section-title">Anomalies (Today)</div><div class="anomaly-summary">';
        for (var ac of d.anomalies.todayCounts) {
          html += '<span class="anomaly-badge">' + escapeHtml(ac.type) + ': ' + ac.count + '</span>';
        }
        html += '</div>';
        if (d.anomalies.recent && d.anomalies.recent.length > 0) {
          html += '<table class="log-table"><tr><th>Time</th><th>Type</th><th>Model</th><th>Message</th></tr>';
          for (var an of d.anomalies.recent.slice(0, 10)) {
            html += '<tr><td>' + formatTime(an.created_at) + '</td><td class="log-error">' + escapeHtml(an.type) + '</td>' +
              '<td>' + escapeHtml((an.model || '').split('-').pop()) + '</td>' +
              '<td>' + escapeHtml((an.message || '').slice(0, 60)) + '</td></tr>';
          }
          html += '</table>';
        }
        html += '</div>';
      }

      // Usage history
      if (d.usageHistory && d.usageHistory.length > 0) {
        var mx = Math.max.apply(null, d.usageHistory.map(function(h) { return h.request_count; }));
        html += '<div class="dash-section"><div class="dash-section-title">Usage History</div><div class="history-bars">';
        for (var h of d.usageHistory.slice().reverse()) {
          var pct = mx > 0 ? (h.request_count / mx * 100) : 0;
          html += '<div class="history-bar" style="height:' + Math.max(4, pct) + '%"><span class="history-bar-value">' +
            h.request_count + '</span><span class="history-bar-label">' + h.date.slice(5) + '</span></div>';
        }
        html += '</div><div style="height:20px;"></div></div>';
      }

      $dashboardContent.innerHTML = html;

      // Bind auto-management toggle buttons on dashboard
      $dashboardContent.querySelectorAll('.dash-auto-toggle').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var feat = btn.getAttribute('data-auto-feature');
          var target = btn.getAttribute('data-auto-target') === 'true';
          try {
            await fetch('/api/auto-management', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ feature: feat, enabled: target }),
            });
            loadDashboard();
          } catch (err) { console.error('Toggle err:', err); }
        });
      });
    } catch (e) {
      console.error('Dash err:', e);
      $dashboardContent.innerHTML = '<div class="empty-state">Error</div>';
    }
  }

  // -----------------------------------------------------------------------
  // Admin
  // -----------------------------------------------------------------------
  async function loadAdmin() {
    $adminContent.innerHTML = '<div class="loading">...</div>';
    try {
      var dashRes = await fetch('/api/dashboard');
      var dashData = await dashRes.json();
      var modelsRes = await fetch('/api/models');
      var modelsData = await modelsRes.json();
      var autoRes = await fetch('/api/auto-management');
      var autoData = await autoRes.json();

      var html = '';

      // Bulk controls
      html += '<div class="admin-section"><div class="admin-section-title">Controls</div><div class="bulk-controls">' +
        '<button class="bulk-btn pause-all" id="btn-pause-all">Pause All</button>' +
        '<button class="bulk-btn resume-all" id="btn-resume-all">Resume All</button>' +
        '<button class="bulk-btn validate" id="btn-validate">Validate Key</button>' +
        '<button class="bulk-btn compute" id="btn-compute-followers">Recalc Followers</button>' +
        '</div><div id="admin-action-result"></div></div>';

      // Auto-management toggles
      if (autoData.settings && autoData.settings.length > 0) {
        html += '<div class="admin-section"><div class="admin-section-title">Auto Management (ON/OFF)</div><div class="control-grid">';
        for (var am of autoData.settings) {
          html += '<div class="control-card"><div><div class="control-feature">' + escapeHtml(am.feature) + '</div>' +
            '<div class="control-status ' + (am.enabled ? 'active' : 'paused') + '">' + (am.enabled ? 'ON' : 'OFF') + '</div></div>' +
            '<button class="control-btn ' + (am.enabled ? 'pause' : 'resume') + '" ' +
            'data-auto-feature="' + am.feature + '" data-auto-enabled="' + (!am.enabled) + '">' +
            (am.enabled ? 'OFF' : 'ON') + '</button></div>';
        }
        html += '</div></div>';
      }

      // Feature controls
      html += '<div class="admin-section"><div class="admin-section-title">Feature Control</div><div class="control-grid">';
      for (var ps of dashData.pauseStates) {
        html += '<div class="control-card"><div><div class="control-feature">' + ps.feature + '</div>' +
          '<div class="control-status ' + (ps.paused ? 'paused' : 'active') + '">' + (ps.paused ? 'Paused' : 'Active') +
          (ps.reason ? ' (' + escapeHtml(ps.reason.slice(0, 25)) + ')' : '') + '</div></div>' +
          '<button class="control-btn ' + (ps.paused ? 'resume' : 'pause') + '" ' +
          'data-feature="' + ps.feature + '" data-action="' + (ps.paused ? 'resume' : 'pause') + '">' +
          (ps.paused ? 'Resume' : 'Pause') + '</button></div>';
      }
      html += '</div></div>';

      // Models with full rate limit table
      html += '<div class="admin-section"><div class="admin-section-title">Models & Rate Limits</div>';
      html += '<table class="log-table rate-limit-table"><tr><th>Model</th><th>Status</th><th>RPM</th><th>RPD</th><th>TPM (In)</th><th>TPM (Out)</th><th>Interval</th><th>Used For</th></tr>';
      for (var m of modelsData.models) {
        var rl = m.rateLimits || {};
        var rpdStr = rl.rpd === null || !isFinite(rl.rpd) ? '<span style="color:#4caf50;font-weight:600;">Unlimited</span>' : rl.rpd.toLocaleString();
        var schedStr = rl.scheduling ? (rl.scheduling.minIntervalMs / 1000) + '-' + (rl.scheduling.maxIntervalMs / 1000) + 's' : '-';
        html += '<tr>' +
          '<td><strong>' + escapeHtml(m.label) + '</strong> <span class="model-badge ' + m.status.toLowerCase() + '">' + m.status + '</span></td>' +
          '<td>' + escapeHtml(m.tier) + '</td>' +
          '<td>' + (rl.rpm || '-').toLocaleString() + '</td>' +
          '<td>' + rpdStr + '</td>' +
          '<td>' + ((rl.tpm_input || 0) / 1000000).toFixed(0) + 'M</td>' +
          '<td>' + ((rl.tpm_output || 0) / 1000).toFixed(0) + 'K</td>' +
          '<td>' + schedStr + '</td>' +
          '<td style="font-size:0.625rem;">' + m.usedFor.join(', ') + '</td></tr>';
      }
      html += '</table>';
      // Model detail cards
      for (var m of modelsData.models) {
        html += '<div class="model-card"><div class="model-name">' + escapeHtml(m.label) +
          '<span class="model-badge ' + m.status.toLowerCase() + '">' + m.status + '</span></div>' +
          '<div class="model-detail">ID: ' + escapeHtml(m.id) + '</div>' +
          '<div class="model-detail">Price: ' + escapeHtml(m.pricing) + '</div>';
        if (m.rateLimits) {
          var rpdStr = m.rateLimits.rpd === null || !isFinite(m.rateLimits.rpd) ? 'Unlimited' : m.rateLimits.rpd.toLocaleString();
          html += '<div class="model-detail">RPM: ' + m.rateLimits.rpm.toLocaleString() + ' / RPD: ' + rpdStr +
            ' / TPM: ' + ((m.rateLimits.tpm_input || 0) / 1000000).toFixed(0) + 'M in, ' +
            ((m.rateLimits.tpm_output || 0) / 1000).toFixed(0) + 'K out</div>';
        }
        html += '<div class="model-detail">For: ' + m.usedFor.join(', ') + '</div></div>';
      }
      html += '</div>';

      // Usage details button
      html += '<div class="admin-section"><div class="admin-section-title">Usage Details</div>' +
        '<button class="bulk-btn validate" id="btn-usage-details">Show</button>' +
        '<div id="usage-details-result"></div></div>';

      $adminContent.innerHTML = html;

      // Bind controls
      $adminContent.querySelectorAll('.control-btn[data-feature]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          await fetch('/api/control/' + btn.dataset.action, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ feature: btn.dataset.feature }),
          });
          loadAdmin();
        });
      });

      // Auto-management toggles (fix: use getAttribute to read data attributes)
      $adminContent.querySelectorAll('.control-btn[data-auto-feature]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var feat = btn.getAttribute('data-auto-feature');
          var target = btn.getAttribute('data-auto-enabled') === 'true';
          await fetch('/api/auto-management', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ feature: feat, enabled: target }),
          });
          loadAdmin();
        });
      });

      $('btn-pause-all').addEventListener('click', async function() {
        await fetch('/api/control/pause-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        loadAdmin();
      });
      $('btn-resume-all').addEventListener('click', async function() {
        await fetch('/api/control/resume-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        loadAdmin();
      });
      $('btn-validate').addEventListener('click', async function() {
        var r = $('admin-action-result');
        r.innerHTML = '<div class="loading">Validating...</div>';
        try {
          var vRes = await fetch('/api/validate-key');
          var vData = await vRes.json();
          var h = '<div class="validate-results">';
          for (var key in vData.results) {
            var v = vData.results[key];
            h += '<div class="validate-item"><strong>' + key + '</strong> (' + escapeHtml(v.model) + '): ' +
              (v.status === 'ok' ? '<span class="validate-ok">OK</span>' : '<span class="validate-err">ERR: ' + escapeHtml(v.error || '') + '</span>') + '</div>';
          }
          h += '</div>';
          r.innerHTML = h;
        } catch (e) { r.innerHTML = '<div class="validate-err">Failed</div>'; }
      });
      $('btn-compute-followers').addEventListener('click', async function() {
        var r = $('admin-action-result');
        r.innerHTML = '<div class="loading">Computing...</div>';
        try {
          var fRes = await fetch('/api/followers/compute');
          var fData = await fRes.json();
          r.innerHTML = '<div style="font-size:0.8125rem;color:#4caf50;padding:8px;">' + fData.followers.length + ' followers updated</div>';
        } catch (e) { r.innerHTML = '<div class="validate-err">Failed</div>'; }
      });
      $('btn-usage-details').addEventListener('click', async function() {
        var r = $('usage-details-result');
        r.innerHTML = '<div class="loading">Loading...</div>';
        try {
          var udRes = await fetch('/api/usage-details?limit=50');
          var udData = await udRes.json();
          var h = '';
          if (udData.todayByModel && udData.todayByModel.length > 0) {
            h += '<table class="log-table"><tr><th>Model</th><th>Feature</th><th>Count</th><th>Errors</th></tr>';
            for (var tm of udData.todayByModel) {
              h += '<tr><td>' + escapeHtml(tm.model) + '</td><td>' + escapeHtml(tm.feature) + '</td><td>' + tm.count + '</td><td>' + tm.error_count + '</td></tr>';
            }
            h += '</table>';
          }
          if (udData.recentLogs && udData.recentLogs.length > 0) {
            h += '<table class="log-table" style="margin-top:8px;"><tr><th>Time</th><th>Model</th><th>Feature</th><th>Result</th></tr>';
            for (var rl of udData.recentLogs.slice(0, 20)) {
              h += '<tr><td>' + formatTime(rl.created_at) + '</td><td>' + escapeHtml(rl.model).split('-').pop() + '</td>' +
                '<td>' + escapeHtml(rl.feature) + '</td><td class="' + (rl.success ? 'log-success' : 'log-error') + '">' +
                (rl.success ? 'OK' : escapeHtml((rl.error_msg || '').slice(0, 30))) + '</td></tr>';
            }
            h += '</table>';
          }
          r.innerHTML = h || '<div class="empty-state">No data</div>';
        } catch (e) { r.innerHTML = '<div class="validate-err">Failed</div>'; }
      });
    } catch (e) {
      console.error('Admin err:', e);
      $adminContent.innerHTML = '<div class="empty-state">Error</div>';
    }
  }

  // Init
  loadTimeline(false);
  startAutoRefresh();
  loadTrending();

})();
