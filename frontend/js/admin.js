/**
 * Admin Dashboard — Delux Radio
 * Handles auth, live status, drag-to-reorder queue, catalog, skip.
 */

const Admin = (() => {
  let _user = '';
  let _pw = '';
  let _pollTimer = null;
  let _progressTimer = null;
  let _songStartedAt = 0;
  let _songDuration  = 240;
  let _allSongs = [];
  let _dragSrcIndex = null;
  let _pendingOrder = null;   // new order after drag

  const $ = id => document.getElementById(id);

  // ── Auth ────────────────────────────────────────────────────────────────────
  function _initAuth() {
    const btn = $('auth-btn');
    const user = $('auth-user');
    const pw  = $('auth-pw');
    const err = $('auth-err');

    const attempt = async () => {
      const username = user.value.trim();
      const password = pw.value.trim();
      if (!username || !password) return;
      btn.disabled = true;
      btn.textContent = 'Verifying…';
      try {
        const res = await fetch('/api/admin/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        if (res.ok) {
          _user = username;
          _pw = password;
          sessionStorage.setItem('delux_admin_user', _user);
          sessionStorage.setItem('delux_admin_pw', _pw);
          _showDashboard();
        } else {
          err.textContent = '✖ Incorrect credentials. Try again.';
          pw.value = '';
          pw.focus();
        }
      } catch {
        err.textContent = '✖ Server unreachable.';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sign In →';
      }
    };

    btn.addEventListener('click', attempt);
    pw.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
    user.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });

    // Restore session
    const savedUser = sessionStorage.getItem('delux_admin_user');
    const savedPw = sessionStorage.getItem('delux_admin_pw');
    if (savedUser && savedPw) { 
      user.value = savedUser;
      pw.value = savedPw; 
      attempt(); 
    }
  }

  function _showDashboard() {
    $('auth-screen').style.display = 'none';
    $('dashboard').style.display   = 'block';
    _loadStatus();
    _loadCatalog();
    _startPolling();
    _initSkip();
    _initLogout();
    _initAddSong();
    _initToggleRJ();
  }

  function _initLogout() {
    $('btn-logout').addEventListener('click', () => {
      sessionStorage.removeItem('delux_admin_user');
      sessionStorage.removeItem('delux_admin_pw');
      location.reload();
    });
  }

  // ── API helpers ─────────────────────────────────────────────────────────────
  function _headers() {
    return { 'x-admin-username': _user, 'x-admin-password': _pw, 'Content-Type': 'application/json' };
  }

  async function _api(method, path, body) {
    const res = await fetch(`/api/admin${path}`, {
      method,
      headers: _headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── Polling ──────────────────────────────────────────────────────────────────
  function _startPolling() {
    _loadStatus();
    _pollTimer = setInterval(_loadStatus, 5000);   // refresh every 5s
    _progressTimer = setInterval(_tickProgress, 1000);
  }

  async function _loadStatus() {
    try {
      const data = await _api('GET', '/status');
      if (!data.success) return;
      const s = data.data;
      _applyStatus(s);
    } catch {}
  }

  function _applyStatus(s) {
    // Header stats
    $('hdr-listeners').textContent = s.listener_count || 0;
    $('hdr-mode').textContent      = s.mode || 'auto';
    $('hdr-rj').textContent        = s.rj_enabled ? 'ON' : 'OFF';
    $('hdr-rj').style.color        = s.rj_enabled ? '#10b981' : '#ef4444';

    // Now Playing
    const song = s.current_song;
    if (song) {
      $('np-title').textContent  = song.title || '—';
      $('np-artist').textContent = [song.artist, song.movie].filter(Boolean).join(' · ');
      const thumb = $('np-thumb');
      if (song.youtube_video_id) {
        thumb.src = `https://img.youtube.com/vi/${song.youtube_video_id}/mqdefault.jpg`;
        thumb.style.display = '';
      } else {
        thumb.style.display = 'none';
      }
    }

    // Sync clock
    if (s.song_started_at > 0) _songStartedAt = s.song_started_at;
    if (s.song_duration   > 0) _songDuration  = s.song_duration;
    else if (song && song.duration > 0) _songDuration = song.duration;
    if (s.server_time     > 0) {
      _songStartedAt = s.song_started_at;
    }

    _tickProgress();

    // Queue
    if (s.upcoming_queue) _renderQueue(s.upcoming_queue);
    
    // Request Queue
    if (s.request_queue !== undefined) _renderRequestQueue(s.request_queue, s.pending_count || 0);

    // Enable skip
    $('btn-skip').disabled = false;
  }

  // ── Progress bar tick ────────────────────────────────────────────────────────
  function _tickProgress() {
    if (!_songStartedAt) return;
    const elapsed  = (Date.now() / 1000) - _songStartedAt;
    const duration = _songDuration || 240;
    const pct      = Math.min(100, (elapsed / duration) * 100);

    $('np-bar').style.width    = `${pct}%`;
    $('np-elapsed').textContent = _fmtTime(elapsed);
    $('np-duration').textContent = _fmtTime(duration);
  }

  function _fmtTime(sec) {
    if (!sec || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ── Skip ─────────────────────────────────────────────────────────────────────
  function _initSkip() {
    $('btn-skip').addEventListener('click', async () => {
      $('btn-skip').disabled = true;
      try {
        await _api('POST', '/skip');
        _toast('⏭ Skipped to next song', 'ok');
        await _loadStatus();
      } catch {
        _toast('Failed to skip', 'err');
      } finally {
        setTimeout(() => { $('btn-skip').disabled = false; }, 2000);
      }
    });
  }

  // ── RJ Toggle ────────────────────────────────────────────────────────────────
  function _initToggleRJ() {
    $('toggle-rj').addEventListener('click', async () => {
      const current = $('hdr-rj').textContent === 'ON';
      try {
        const res = await _api('POST', '/toggle-rj', { enabled: !current });
        _toast(`RJ features turned ${res.rj_enabled ? 'ON' : 'OFF'}`, 'ok');
        await _loadStatus();
      } catch {
        _toast('Failed to toggle RJ', 'err');
      }
    });
  }

  // ── Queue ─────────────────────────────────────────────────────────────────────
  function _renderQueue(queue) {
    const list = $('queue-list');
    if (!queue || queue.length === 0) {
      list.innerHTML = '<div class="queue-empty">No upcoming songs</div>';
      $('btn-save').disabled = true;
      return;
    }

    list.innerHTML = '';
    queue.forEach((song, i) => {
      const item = document.createElement('div');
      item.className = 'queue-item';
      item.draggable = true;
      item.dataset.index = i;
      item.dataset.songId = song.id;

      const thumb = song.youtube_video_id
        ? `<img class="q-thumb" src="https://img.youtube.com/vi/${song.youtube_video_id}/default.jpg" alt="" />`
        : `<div class="q-thumb"></div>`;

      const durBadge = song.duration ? `<span class="q-dur">${_fmtTime(song.duration)}</span>` : '';
      item.innerHTML = `
        <div class="q-rank ${i === 0 ? 'first' : ''}">${i + 1}</div>
        <span class="q-handle" title="Drag to reorder">⠿</span>
        ${thumb}
        <div class="q-info">
          <div class="q-title" style="display:flex; justify-content:space-between; align-items:center; padding-right:8px;">
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${_esc(song.title)}</span>
            ${durBadge}
          </div>
          <div class="q-artist">${_esc(song.artist || '')}${song.movie ? ' · ' + _esc(song.movie) : ''}</div>
        </div>
        <button class="btn-rm" data-song-id="${song.id}" title="Remove from queue">✕</button>
      `;

      // Drag events
      item.addEventListener('dragstart', _onDragStart);
      item.addEventListener('dragover',  _onDragOver);
      item.addEventListener('dragleave', _onDragLeave);
      item.addEventListener('drop',      _onDrop);
      item.addEventListener('dragend',   _onDragEnd);

      // Remove button
      item.querySelector('.btn-rm').addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(e.currentTarget.dataset.songId);
        await _removeFromQueue(id);
      });

      list.appendChild(item);
    });

    $('btn-save').disabled   = true;   // disabled until user drags
    $('btn-save').onclick     = _saveOrder;
    _pendingOrder = null;
  }

  // ── Listener Request Queue ──────────────────────────────────────────────────
  function _renderRequestQueue(queue, pendingCount) {
    const list = $('request-queue-list');
    
    if ((!queue || queue.length === 0) && pendingCount === 0) {
      list.innerHTML = '<div class="queue-empty">No active requests</div>';
      return;
    }

    list.innerHTML = '';
    
    // First, show ready requests
    queue.forEach((req, i) => {
      const song = req.song;
      const item = document.createElement('div');
      item.className = 'queue-item';
      item.style.cursor = 'default';

      const thumb = song.youtube_video_id
        ? `<img class="q-thumb" src="https://img.youtube.com/vi/${song.youtube_video_id}/default.jpg" alt="" />`
        : `<div class="q-thumb"></div>`;

      item.innerHTML = `
        <div class="q-rank first">★</div>
        ${thumb}
        <div class="q-info">
          <div class="q-title" style="display:flex; justify-content:space-between; align-items:center; padding-right:12px;">
             <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${_esc(song.title)}</span>
             <span style="font-size:10px;background:#10b981;color:#fff;padding:2px 6px;border-radius:10px;font-weight:600;flex-shrink:0;">READY</span>
          </div>
          <div class="q-artist">Req by: ${_esc(req.requester_name)}</div>
        </div>
      `;
      list.appendChild(item);
    });
    
    // Then, show pending AI tasks
    if (pendingCount > 0) {
      const loader = document.createElement('div');
      loader.className = 'queue-item';
      loader.style.cursor = 'default';
      loader.style.background = 'rgba(245,158,11,0.05)';
      loader.innerHTML = `
         <div class="q-rank" style="background:transparent;">⏳</div>
         <div class="q-thumb" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:var(--surface);">🤖</div>
         <div class="q-info">
           <div class="q-title" style="color:var(--amber-dk);">AI is generating RJ voice...</div>
           <div class="q-artist">${pendingCount} request(s) processing in background</div>
         </div>
      `;
      list.appendChild(loader);
    }
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────────
  function _onDragStart(e) {
    _dragSrcIndex = parseInt(this.dataset.index);
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }

  function _onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.queue-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    this.classList.add('drag-over');
    return false;
  }

  function _onDragLeave() {
    this.classList.remove('drag-over');
  }

  function _onDrop(e) {
    e.stopPropagation();
    const destIndex = parseInt(this.dataset.index);
    if (_dragSrcIndex === null || _dragSrcIndex === destIndex) return;

    // Reorder the DOM visually
    const list  = $('queue-list');
    const items = [...list.querySelectorAll('.queue-item')];
    const moved = items.splice(_dragSrcIndex, 1)[0];
    items.splice(destIndex, 0, moved);

    // Re-render with new numbering
    items.forEach((el, i) => {
      el.dataset.index = i;
      el.querySelector('.q-rank').textContent  = i + 1;
      el.querySelector('.q-rank').className    = `q-rank ${i === 0 ? 'first' : ''}`;
      list.appendChild(el);
    });

    // Capture new order
    _pendingOrder = items.map(el => parseInt(el.dataset.songId));
    $('btn-save').disabled = false;
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    return false;
  }

  function _onDragEnd() {
    this.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  async function _saveOrder() {
    if (!_pendingOrder) return;
    $('btn-save').disabled = true;
    $('btn-save').textContent = '⏳ Saving…';
    try {
      await _api('PUT', '/upcoming/reorder', { song_ids: _pendingOrder });
      _toast('✅ Queue order saved!', 'ok');
      _pendingOrder = null;
      await _loadStatus();
    } catch {
      _toast('Failed to save order', 'err');
      $('btn-save').disabled = false;
    } finally {
      $('btn-save').innerHTML = '💾 Save Queue Order';
    }
  }

  async function _removeFromQueue(songId) {
    try {
      await _api('DELETE', `/upcoming/${songId}`);
      _toast('Removed from queue', 'ok');
      await _loadStatus();
    } catch {
      _toast('Failed to remove', 'err');
    }
  }

  // ── Catalog ───────────────────────────────────────────────────────────────────
  async function _loadCatalog() {
    try {
      const data = await _api('GET', '/songs');
      if (!data.success) return;
      _allSongs = data.songs;
      $('catalog-count').textContent = `${_allSongs.length} songs`;
      _renderCatalog(_allSongs);
      $('cat-search').addEventListener('input', e => {
        const q = e.target.value.toLowerCase();
        const filtered = _allSongs.filter(s =>
          s.title.toLowerCase().includes(q) ||
          s.artist.toLowerCase().includes(q) ||
          (s.movie || '').toLowerCase().includes(q)
        );
        _renderCatalog(filtered);
      });
    } catch {
      $('cat-list').innerHTML = '<div style="text-align:center;color:#f87171;font-size:13px;padding:20px">Failed to load catalog</div>';
    }
  }

  function _renderCatalog(songs) {
    const list = $('cat-list');
    if (!songs.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:13px;padding:20px">No songs found</div>';
      return;
    }
    list.innerHTML = '';
    songs.forEach(song => {
      const item = document.createElement('div');
      item.className = 'cat-item';
      const durBadge = song.duration ? `<span class="cat-dur">${_fmtTime(song.duration)}</span>` : '';
      item.innerHTML = `
        <div class="cat-info">
          <div class="cat-title">${_esc(song.title)} ${durBadge}</div>
          <div class="cat-sub">${_esc(song.artist)}${song.movie ? ' · ' + _esc(song.movie) : ''} ${song.release_year ? '(' + song.release_year + ')' : ''}</div>
        </div>
        <button class="btn-outline btn-add-queue" data-song-id="${song.id}">+ Add to Queue</button>
      `;
      item.querySelector('.btn-add-queue').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          await _api('POST', '/upcoming/add', { song_id: song.id, position: 0 });
          _toast(`⚡ "${song.title}" added to top of queue (plays next)`, 'ok');
          await _loadStatus();
        } catch (err) {
          _toast('Could not add — queue may be full', 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = '+ Add to Queue';
        }
      });
      list.appendChild(item);
    });
  }

  // ── Add Song Modal ────────────────────────────────────────────────────────────
  function _initAddSong() {
    const modal = $('add-song-modal');
    const form = $('add-song-form');
    
    $('btn-open-add-song').addEventListener('click', () => {
      modal.classList.add('show');
      $('new-title').focus();
    });

    $('btn-close-modal').addEventListener('click', () => {
      modal.classList.remove('show');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('show');
    });

    $('btn-fetch-yt').addEventListener('click', async () => {
      const ytInput = $('new-yt').value.trim();
      const err = $('new-error');
      if (!ytInput) return;
      
      let yt = ytInput;
      const ytMatch = yt.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
      if (ytMatch) yt = ytMatch[1];
      if (yt.length !== 11) {
        err.textContent = "Invalid YouTube Link or ID.";
        err.style.display = 'block';
        return;
      }
      
      const btn = $('btn-fetch-yt');
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const data = await _api('GET', `/yt-info?url=https://www.youtube.com/watch?v=${yt}`);
        if (data.success) {
           let title = data.title || '';
           let artist = data.author || '';
           $('new-title').value = title;
           $('new-artist').value = artist;
           $('new-yt').value = yt;
           err.style.display = 'none';

           // Attempt to fetch Movie/Album and Year from iTunes
           try {
             let cleanTitle = title.replace(/\([^)]+\)|\[[^\]]+\]/g, ' ');
             cleanTitle = cleanTitle.split('|')[0];
             cleanTitle = cleanTitle.replace(/video|lyrical|full song|audio|official/gi, ' ').trim();
             
             const itunesRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle)}&entity=song&limit=10`);
             if (itunesRes.ok) {
               const iData = await itunesRes.json();
               if (iData.results && iData.results.length > 0) {
                 let oldestRes = iData.results[0];
                 let oldestYear = 9999;
                 
                 for (const res of iData.results) {
                   if (res.releaseDate) {
                     const yr = parseInt(res.releaseDate.substring(0, 4));
                     if (yr < oldestYear) {
                       oldestYear = yr;
                       oldestRes = res;
                     }
                   }
                 }
                 
                 if (oldestRes.collectionName) {
                   let movie = oldestRes.collectionName.replace(/\(Original Motion Picture Soundtrack\)|\(Soundtrack\)|\(Original Soundtrack\)|\(Deluxe Edition\)/i, '').trim();
                   $('new-movie').value = movie;
                 }
                 if (oldestYear !== 9999) {
                   $('new-year').value = oldestYear;
                 }
               }
             }
           } catch (e) {
             console.log("iTunes fetch failed", e);
           }
        }
      } catch (e) {
        err.textContent = "Failed to fetch YouTube details.";
        err.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch';
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('btn-submit-song');
      const err = $('new-error');
      
      const title = $('new-title').value.trim();
      const artist = $('new-artist').value.trim();
      const movie = $('new-movie').value.trim();
      const year = parseInt($('new-year').value);
      let yt = $('new-yt').value.trim();
      
      if (!title || !artist || !year || !yt) return;
      
      const ytMatch = yt.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
      if (ytMatch) yt = ytMatch[1];
      if (yt.length !== 11) {
        err.textContent = "Invalid YouTube ID. Must be 11 characters.";
        err.style.display = 'block';
        return;
      }
      
      err.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Adding…';
      
      try {
        await _api('POST', '/songs', {
          title, artist, movie, release_year: year, youtube_video_id: yt
        });
        _toast('Song added successfully!', 'ok');
        modal.classList.remove('show');
        form.reset();
        await _loadCatalog();
      } catch (error) {
        err.textContent = "Failed to add song. Try again.";
        err.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Add to Catalog';
      }
    });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────────
  let _toastTimer = null;
  function _toast(msg, type = 'ok') {
    const el = $('toast');
    el.textContent = msg;
    el.className   = `toast ${type} show`;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2800);
  }

  // ── Utils ─────────────────────────────────────────────────────────────────────
  function _esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  _initAuth();

})();
