// ===========================================================================
// app.js - A-Talk Frontend Application
// ===========================================================================
// - 全てのデータ取得は /api/* エンドポイント経由
// - Gemini APIに直接アクセスしない
// - フロントエンドにAPIキーやDB情報を保持しない
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

  // Auto-refresh timer
  let autoRefreshTimer = null;
  const AUTO_REFRESH_INTERVAL = 30_000; // 30 seconds

  // -----------------------------------------------------------------------
  // DOM Elements
  // -----------------------------------------------------------------------
  const $timelinePosts = document.getElementById('timeline-posts');
  const $timelineLoading = document.getElementById('timeline-loading');
  const $timelineLoadMore = document.getElementById('timeline-load-more');
  const $timelineEmpty = document.getElementById('timeline-empty');
  const $postModal = document.getElementById('post-modal');
  const $modalPost = document.getElementById('modal-post');
  const $modalCommentsList = document.getElementById('modal-comments-list');
  const $modalCommentsLoading = document.getElementById('modal-comments-loading');
  const $modalCommentsEmpty = document.getElementById('modal-comments-empty');
  const $modalReactionsHeader = document.getElementById('modal-reactions-header');
  const $modalReactionsList = document.getElementById('modal-reactions-list');
  const $modalReactionsLoading = document.getElementById('modal-reactions-loading');
  const $modalReactionsTrigger = document.getElementById('modal-reactions-trigger');
  const $usersList = document.getElementById('users-list');
  const $dmHeader = document.getElementById('dm-header');
  const $dmMessages = document.getElementById('dm-messages');
  const $dmLoading = document.getElementById('dm-loading');
  const $statusContent = document.getElementById('status-content');

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  function formatTime(isoString) {
    const date = new Date(isoString + 'Z');
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return 'たった今';
    if (diffMin < 60) return diffMin + '分前';
    if (diffHour < 24) return diffHour + '時間前';
    if (diffDay < 7) return diffDay + '日前';

    return date.toLocaleDateString('ja-JP', {
      month: 'short',
      day: 'numeric',
    });
  }

  function renderPostContent(content) {
    const escaped = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    return escaped.replace(
      /\[(.+?)\]/g,
      '<span class="post-media">[$1]</span>'
    );
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      switchView(view);
    });
  });

  function switchView(view) {
    currentView = view;

    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector('.nav-btn[data-view="' + view + '"]');
    if (activeBtn) activeBtn.classList.add('active');

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('view-' + view);
    if (target) target.classList.add('active');

    if (view === 'timeline') {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }

    if (view === 'users') loadUsers();
    if (view === 'status') loadStatus();
  }

  // -----------------------------------------------------------------------
  // Timeline
  // -----------------------------------------------------------------------

  async function loadTimeline(append) {
    if (timelineLoading) return;
    timelineLoading = true;

    if (!append) {
      timelineOffset = 0;
      $timelinePosts.innerHTML = '';
    }

    $timelineLoading.style.display = 'block';
    $timelineLoadMore.style.display = 'none';
    $timelineEmpty.style.display = 'none';

    try {
      const res = await fetch(
        '/api/timeline?limit=' + TIMELINE_LIMIT + '&offset=' + timelineOffset
      );
      const data = await res.json();

      if (!append && data.posts.length === 0) {
        $timelineEmpty.style.display = 'block';
        $timelineLoading.style.display = 'none';
        timelineLoading = false;
        return;
      }

      for (const post of data.posts) {
        const el = createPostCard(post);
        $timelinePosts.appendChild(el);
      }

      timelineOffset += data.posts.length;
      timelineHasMore = data.pagination.hasMore;

      $timelineLoadMore.style.display = timelineHasMore ? 'block' : 'none';
    } catch (err) {
      console.error('Timeline load error:', err);
    }

    $timelineLoading.style.display = 'none';
    timelineLoading = false;
  }

  async function refreshTimeline() {
    try {
      const res = await fetch('/api/timeline?limit=5&offset=0');
      const data = await res.json();

      if (data.posts.length === 0) return;

      const firstCard = $timelinePosts.querySelector('.post-card');
      const firstId = firstCard ? parseInt(firstCard.dataset.id, 10) : 0;

      const newPosts = data.posts.filter(p => p.id > firstId);
      for (let i = newPosts.length - 1; i >= 0; i--) {
        const el = createPostCard(newPosts[i]);
        el.classList.add('new-post');
        $timelinePosts.insertBefore(el, $timelinePosts.firstChild);
        timelineOffset++;
      }

      if (newPosts.length > 0) {
        $timelineEmpty.style.display = 'none';
      }
    } catch (err) {
      // Silently fail on auto-refresh
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(refreshTimeline, AUTO_REFRESH_INTERVAL);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  function createPostCard(post) {
    const card = document.createElement('div');
    card.className = 'post-card';
    card.dataset.id = post.id;

    card.innerHTML =
      '<div class="post-header">' +
        '<span class="post-username">' + escapeHtml(post.username) + '</span>' +
        '<span class="post-time">' + formatTime(post.created_at) + '</span>' +
      '</div>' +
      '<div class="post-content">' + renderPostContent(post.content) + '</div>' +
      '<div class="post-footer">' +
        '<span class="post-likes">いいね ' + post.likes + '</span>' +
      '</div>';

    card.addEventListener('click', function() { openPostModal(post.id); });
    return card;
  }

  $timelineLoadMore.addEventListener('click', function() {
    if (timelineHasMore) loadTimeline(true);
  });

  // -----------------------------------------------------------------------
  // Post Modal
  // -----------------------------------------------------------------------

  let currentModalPostId = null;

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
      // Fetch post detail
      const postRes = await fetch('/api/posts/' + postId);
      const postData = await postRes.json();
      const post = postData.post;

      $modalPost.innerHTML =
        '<div class="post-header">' +
          '<span class="post-username">' + escapeHtml(post.username) + '</span>' +
          '<span class="post-time">' + formatTime(post.created_at) + '</span>' +
        '</div>' +
        '<div class="post-content">' + renderPostContent(post.content) + '</div>' +
        '<div class="post-footer">' +
          '<span class="post-likes">いいね ' + post.likes + '</span>' +
          '<span style="font-size:0.75rem;color:#aaa;">score: ' + post.popularity_score + '</span>' +
        '</div>';

      // Fetch comments (triggers on-demand generation for popular posts)
      const commentsRes = await fetch('/api/posts/' + postId + '/comments');
      const commentsData = await commentsRes.json();

      $modalCommentsLoading.style.display = 'none';

      if (commentsData.comments && commentsData.comments.length > 0) {
        for (const comment of commentsData.comments) {
          var el = document.createElement('div');
          el.className = 'comment-item';
          el.innerHTML =
            '<div class="comment-username">' + escapeHtml(comment.username) + '</div>' +
            '<div class="comment-text">' + escapeHtml(comment.content) + '</div>';
          $modalCommentsList.appendChild(el);
        }
      } else {
        $modalCommentsEmpty.style.display = 'block';
        $modalCommentsEmpty.textContent =
          post.popularity_score >= 60
            ? 'コメントはまだありません'
            : 'この投稿にはコメントがつきません';
      }

      // Show existing reactions if any
      if (postData.reactions && postData.reactions.length > 0) {
        renderReactions(postData.reactions);
      } else if (post.popularity_score >= 70) {
        // Show trigger button for high-popularity posts
        $modalReactionsTrigger.style.display = 'block';
      }

    } catch (err) {
      console.error('Post modal load error:', err);
      $modalCommentsLoading.style.display = 'none';
    }
  }

  function renderReactions(reactions) {
    $modalReactionsHeader.style.display = 'block';
    $modalReactionsList.innerHTML = '';
    $modalReactionsTrigger.style.display = 'none';

    for (const reaction of reactions) {
      var el = document.createElement('div');
      el.className = 'reaction-item';
      el.setAttribute('data-depth', reaction.depth);
      el.style.animationDelay = (reaction.depth * 0.15) + 's';
      el.innerHTML =
        '<div class="reaction-username">' + escapeHtml(reaction.username) + '</div>' +
        '<div class="reaction-text">' + escapeHtml(reaction.content) + '</div>';
      $modalReactionsList.appendChild(el);
    }
  }

  // Reaction Chain trigger button handler
  $modalReactionsTrigger.addEventListener('click', async function() {
    if (!currentModalPostId) return;

    $modalReactionsTrigger.style.display = 'none';
    $modalReactionsLoading.style.display = 'block';

    try {
      var res = await fetch('/api/posts/' + currentModalPostId + '/reactions');
      var data = await res.json();

      $modalReactionsLoading.style.display = 'none';

      if (data.reactions && data.reactions.length > 0) {
        renderReactions(data.reactions);
      } else {
        $modalReactionsHeader.style.display = 'block';
        $modalReactionsList.innerHTML =
          '<div class="empty-state" style="padding:16px;">チェーンを生成できませんでした</div>';
      }
    } catch (err) {
      console.error('Reaction chain load error:', err);
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

      for (var u = 0; u < data.users.length; u++) {
        var user = data.users[u];
        var card = document.createElement('div');
        card.className = 'user-card';
        card.innerHTML =
          '<span class="user-name">' + escapeHtml(user.username) + '</span>' +
          '<div class="user-actions">' +
            '<button class="dm-btn" data-user-id="' + user.id + '" data-username="' + escapeHtml(user.username) + '">DM</button>' +
          '</div>';
        $usersList.appendChild(card);
      }

      $usersList.querySelectorAll('.dm-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var userId = parseInt(btn.dataset.userId, 10);
          var allIds = data.users.map(function(u) { return u.id; }).filter(function(id) { return id !== userId; });
          var otherIdx = Math.floor(Math.random() * allIds.length);
          var otherId = allIds[otherIdx];
          openDMView(userId, otherId, btn.dataset.username);
        });
      });
    } catch (err) {
      console.error('Users load error:', err);
    }
  }

  // -----------------------------------------------------------------------
  // DM
  // -----------------------------------------------------------------------

  async function openDMView(userAId, userBId, username) {
    switchView('dm');
    document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });

    $dmHeader.innerHTML =
      '<button class="back-btn" id="dm-back">戻る</button>' +
      '<p>' + escapeHtml(username) + ' のダイレクトメッセージ</p>';
    $dmMessages.innerHTML = '';
    $dmLoading.style.display = 'block';

    document.getElementById('dm-back').addEventListener('click', function() {
      switchView('users');
    });

    try {
      var res = await fetch('/api/dm/' + userAId + '/' + userBId);
      var data = await res.json();

      $dmLoading.style.display = 'none';

      if (data.messages && data.messages.length > 0) {
        for (var m = 0; m < data.messages.length; m++) {
          var msg = data.messages[m];
          var bubble = document.createElement('div');
          var isFrom = msg.from_user_id === userAId;
          bubble.className = 'dm-bubble ' + (isFrom ? 'from' : 'to');
          bubble.innerHTML =
            '<div class="dm-sender">' + escapeHtml(isFrom ? msg.from_username : msg.to_username) + '</div>' +
            '<div>' + escapeHtml(msg.content) + '</div>';
          $dmMessages.appendChild(bubble);
        }
      } else {
        $dmMessages.innerHTML = '<div class="empty-state">メッセージはまだありません</div>';
      }
    } catch (err) {
      console.error('DM load error:', err);
      $dmLoading.style.display = 'none';
    }
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  async function loadStatus() {
    $statusContent.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      var res = await fetch('/api/status');
      var data = await res.json();

      var dailyPercent = Math.round(
        (data.quota.dailyUsage / data.quota.dailyLimit) * 100
      );

      $statusContent.innerHTML =
        '<div class="status-grid">' +
          '<div class="status-card">' +
            '<div class="status-label">本日のAPI使用量</div>' +
            '<div class="status-value">' + data.quota.dailyUsage + '</div>' +
            '<div class="status-sub">上限 ' + data.quota.dailyLimit + ' (' + dailyPercent + '%)</div>' +
          '</div>' +
          '<div class="status-card">' +
            '<div class="status-label">直近1分のリクエスト</div>' +
            '<div class="status-value">' + data.quota.rpmWindowCount + '</div>' +
            '<div class="status-sub">上限 ' + data.quota.rpmLimit + ' RPM</div>' +
          '</div>' +
          '<div class="status-card">' +
            '<div class="status-label">総投稿数</div>' +
            '<div class="status-value">' + data.postCount + '</div>' +
            '<div class="status-sub"></div>' +
          '</div>' +
          '<div class="status-card">' +
            '<div class="status-label">AIユーザー数</div>' +
            '<div class="status-value">' + data.userCount + '</div>' +
            '<div class="status-sub"></div>' +
          '</div>' +
          '<div class="status-card">' +
            '<div class="status-label">使用モデル</div>' +
            '<div class="status-value" style="font-size:0.875rem;">' + escapeHtml(data.quota.model) + '</div>' +
            '<div class="status-sub">Gemini 2.5 Flash-Lite (Stable)</div>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top: 16px; font-size: 0.75rem; color: #999; text-align: right;">' +
          'サーバー時刻: ' + new Date(data.serverTime).toLocaleString('ja-JP') +
        '</div>';
    } catch (err) {
      console.error('Status load error:', err);
      $statusContent.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
    }
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------
  loadTimeline(false);
  startAutoRefresh();

})();
