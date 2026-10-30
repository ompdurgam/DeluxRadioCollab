/**
 * Delux Radio — Main App Controller
 * ─────────────────────────────────
 * RADIO SYNC: All listeners play the same song at the same position.
 *
 * How it works:
 *   - Server records song_started_at (Unix float) when each song begins.
 *   - Server also sends server_time (current Unix float) in every state update.
 *   - Client computes: clockDrift = serverTime - Date.now()/1000
 *   - When joining mid-song: seekOffset = (Date.now()/1000 + clockDrift) - song_started_at
 *   - Player.loadVideo(videoId, true, seekOffset) — seeks to the live position.
 *
 * KEY RULES:
 *   - Never auto-play on page load (browser blocks it).
 *   - Only start YouTube on user click.
 *   - After first interaction, songs auto-advance via onEnded.
 */

const App = (() => {
  const state = {
    username:      localStorage.getItem('delux_username') || '',
    clientId:      _genId(),
    ws:            null,
    isPlaying:     false,
    isMuted:       false,
    volume:        80,
    currentSong:   null,   // current song metadata (for display even before playing)
    radioMode:     'auto',
    listeners:     0,
    rjAudio:       null,
    rjPlaying:     false,
    wsConnected:   false,
    ytLoaded:      false,  // YT player has a video loaded and can .play()
    // Sync clock
    songStartedAt:  0,     // Server's Unix timestamp when current song started
    songDuration:   0,     // Current song total duration in seconds
    clockDrift:     0,     // Estimated difference: server_time - local_time
  };

  const $ = id => document.getElementById(id);

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    if (!state.username) {
      _showUsernameModal();
    } else {
      _boot();
    }
  }

  function _boot() {
    _initControls();
    Chat.init(null, state.username, state.clientId);  // bind events once
    RequestModule.init();
    _updateUsernameDisplay();
    _startProgressTick();
    _connectWebSocket();
    _fetchInitialState();
  }

  // ── Username modal ─────────────────────────────────────────────────────────
  function _showUsernameModal() {
    const overlay = $('username-modal-overlay');
    if (!overlay) return;
    overlay.classList.add('open');

    const submit = () => {
      const name = $('username-input')?.value?.trim();
      if (!name) return;
      state.username = name;
      localStorage.setItem('delux_username', name);
      overlay.classList.remove('open');
      _boot();
    };

    $('username-submit')?.addEventListener('click', submit);
    $('username-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
    });
    setTimeout(() => $('username-input')?.focus(), 300);
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  function _connectWebSocket() {
    const wsUrl = `ws://${location.host}/ws`;
    try {
      state.ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[WS] Connect failed:', e);
      setTimeout(_connectWebSocket, 3000);
      return;
    }
    // Update Chat's WS reference (don't re-bind events)
    Chat.setWs(state.ws);

    state.ws.onopen = () => {
      state.wsConnected = true;
      state.ws.send(JSON.stringify({ type: 'set_username', username: state.username }));
    };
    state.ws.onmessage = e => {
      try { _handleWsMessage(JSON.parse(e.data)); } catch {}
    };
    state.ws.onclose = () => {
      state.wsConnected = false;
      setTimeout(_connectWebSocket, 3000);
    };
    state.ws.onerror = () => {};
  }

  function _handleWsMessage(msg) {
    switch (msg.type) {
      case 'radio_state':
        _applyRadioState(msg.data);
        break;
      case 'chat_history':
        Chat.renderHistory(msg.data);
        break;
      case 'chat_message':
        Chat.renderMessage(msg.data);
        break;
      case 'typing':
        Chat.handleTyping(msg.data || {});
        break;
      case 'stop_typing':
        Chat.handleStopTyping(msg.data || {});
        break;
      case 'user_joined':
        Chat.renderSystem(`${msg.data?.display_name || 'Someone'} joined the station 📻`);
        break;
      case 'play_next':
      case 'admin_skip': {
        // Server has authoritatively moved to the next song.
        // Always update display. Auto-play only if the user had already clicked Play.
        const nextData = msg.type === 'admin_skip' ? msg.data?.next : msg.data;
        if (nextData) _handlePlayNext(nextData);
        break;
      }
      case 'notification':
        _showToast(msg.data?.title, msg.data?.body, msg.data?.notif_type);
        break;
      case 'error':
        Chat.renderError(msg.message);
        break;
    }
  }


  // ── Sync clock helpers ─────────────────────────────────────────────────────
  /**
   * Returns the current "radio time" in seconds, adjusted for server clock drift.
   */
  function _radioNow() {
    return (Date.now() / 1000) + state.clockDrift;
  }

  /**
   * How many seconds into the current song we should be right now.
   * Returns 0 if we haven't started or song just started.
   */
  function _getSyncOffset() {
    if (!state.songStartedAt || state.songStartedAt <= 0) return 0;
    const elapsed = _radioNow() - state.songStartedAt;
    return Math.max(0, elapsed);
  }

  // ── Radio state ────────────────────────────────────────────────────────────
  function _applyRadioState(data) {
    if (!data) return;

    // ── Update sync clock ────────────────────────────────────────────────────
    if (data.server_time && data.server_time > 0) {
      // Estimate clock drift (positive = server is ahead of us)
      state.clockDrift = data.server_time - (Date.now() / 1000);
    }
    if (data.song_started_at && data.song_started_at > 0) {
      state.songStartedAt = data.song_started_at;
    }

    if (data.song_duration && data.song_duration > 0) {
      state.songDuration = data.song_duration;
    } else if (data.current_song?.duration) {
      state.songDuration = data.current_song.duration;
    }

    state.listeners = data.listener_count || 0;
    state.radioMode  = data.mode || 'auto';

    _updateListeners(state.listeners);
    _updateModePill(state.radioMode);
    const q = (data.request_queue && data.request_queue.length)
      ? data.request_queue
      : (data.upcoming_queue || data.queue || []);
    _updateQueue(q);

    // Update song display (but DON'T start playback — wait for user click)
    const song = data.current_song;
    if (song) {
      if (!state.currentSong || state.currentSong.youtube_video_id !== song.youtube_video_id) {
        state.currentSong = song;
        _updateSongDisplay(song);
      }
    }
  }

  async function _fetchInitialState() {
    try {
      const res  = await fetch('/api/radio/state');
      const data = await res.json();
      if (!data.success) return;
      _applyRadioState(data.state);
      // Show song info only — NO playback until user clicks Play
    } catch (e) {
      console.warn('[App] Failed to fetch initial state:', e);
    }
  }

  // ── Song transitions ───────────────────────────────────────────────────────
  function _onYTSongEnded() {
    if (!state.isPlaying) return;
    // Tell server the song ended → server picks next → broadcasts play_next to ALL clients
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'song_ended' }));
    } else {
      // Fallback: REST call
      fetch('/api/radio/song-ended', { method: 'POST' })
        .then(r => r.json())
        .then(d => { if (d?.next) _handlePlayNext(d.next); })
        .catch(() => {});
    }
  }

  function _handlePlayNext(data) {
    if (!data || data.type === 'error') return;

    // Update server clock — all clients get the same started_at so they're in sync
    if (data.started_at) {
      state.songStartedAt  = data.started_at;
      state.ytLoaded       = false;  // new song = must load fresh
    }

    // Always update the UI display (song title, artist, cover art)
    const song = data.song;
    if (song) {
      state.currentSong = song;
      _updateSongDisplay(song);
    }

    // Only load into the YouTube player if the user has already clicked Play.
    // If they haven't, they'll tune in at the correct offset when they do click.
    if (!state.isPlaying) return;

    if (data.rj_audio_url && song) {
      // Request mode: play RJ announcement first, then song from the start
      _playRJAnnouncement(data.rj_audio_url, () => {
        _loadYTSong(song, 0);
      });
    } else if (song) {
      // Server just started this song — offset is how many seconds have elapsed
      // since started_at (typically 0–2s due to network latency)
      const offset = data.started_at ? Math.max(0, _radioNow() - data.started_at) : 0;
      console.log(`[Sync] Server advanced → "${song.title}" at offset ${offset.toFixed(1)}s`);
      _loadYTSong(song, offset);
    }
  }


  /**
   * Load a song into the YouTube player and start playing.
   * @param {Object} song
   * @param {number} startSeconds - Seek offset for sync (0 = from start)
   */
  function _loadYTSong(song, startSeconds = 0) {
    if (!song?.youtube_video_id) return;

    state.currentSong = song;
    _updateSongDisplay(song);
    _updatePlayBtn(true);
    _startEq();
    $('cover-disc')?.classList.add('spinning');

    // Clamp offset — don't seek more than ~10 minutes in (safety)
    const seekTo = Math.min(startSeconds, 600);
    console.log(`[Sync] Loading "${song.title}" at ${seekTo.toFixed(1)}s`);
    Player.loadVideo(song.youtube_video_id, true, seekTo);
  }

  function _playRJAnnouncement(url, onDone) {
    Player.setVolume(20);
    state.rjPlaying = true;
    _showRJBanner();

    const audio = new Audio(url);
    const finish = () => {
      state.rjPlaying = false;
      Player.setVolume(state.volume);
      _hideRJBanner();
      
      // Store the RJ audio duration so we can add it to the YT duration later
      if (audio.duration && !isNaN(audio.duration)) {
        state.lastRjDuration = audio.duration;
      } else {
        state.lastRjDuration = 0;
      }
      
      if (onDone) onDone();
    };
    audio.addEventListener('ended', finish);
    audio.addEventListener('error', finish);
    audio.play().catch(finish);
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  function _initControls() {
    $('btn-play')?.addEventListener('click', _handlePlayPause);

    // Volume
    const vol = $('volume-slider');
    if (vol) {
      vol.value = state.volume;
      vol.style.setProperty('--pct', `${state.volume}%`);
      vol.addEventListener('input', e => {
        state.volume = parseInt(e.target.value);
        Player.setVolume(state.volume);
        e.target.style.setProperty('--pct', `${state.volume}%`);
        const muteBtn = $('btn-mute');
        if (muteBtn) muteBtn.textContent = state.volume === 0 ? '🔇' : '🔊';
      });
    }

    // Mute
    $('btn-mute')?.addEventListener('click', () => {
      state.isMuted = !state.isMuted;
      Player.setMuted(state.isMuted);
      const btn = $('btn-mute');
      if (btn) btn.textContent = state.isMuted ? '🔇' : '🔊';
    });

    // Chat
    $('btn-open-chat')?.addEventListener('click', () => $('chat-panel')?.classList.add('open'));
    $('btn-close-chat')?.addEventListener('click', () => $('chat-panel')?.classList.remove('open'));

    // Request
    $('btn-open-request')?.addEventListener('click', () => RequestModule.open());

    // Support
    $('btn-support')?.addEventListener('click', () => $('support-modal')?.classList.add('open'));
    ['btn-close-support', 'btn-close-support-2'].forEach(id =>
      $(id)?.addEventListener('click', () => $('support-modal')?.classList.remove('open')));
    $('support-modal')?.addEventListener('click', e => {
      if (e.target === $('support-modal')) $('support-modal').classList.remove('open');
    });

    // Rename
    $('btn-rename')?.addEventListener('click', () => {
      const n = prompt('Enter your name:', state.username);
      if (n?.trim()) {
        state.username = n.trim();
        localStorage.setItem('delux_username', state.username);
        _updateUsernameDisplay();
        Chat.setUsername(state.username);
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'set_username', username: state.username }));
        }
      }
    });

    // YouTube callbacks — client is a PASSIVE LISTENER
    // The server auto-loop decides when to advance; clients never call song_ended.

    Player.onPlaying((videoId) => {
      state.isPlaying = true;
      state.ytLoaded  = true;
      _updatePlayBtn(true);
      _startEq();
      $('cover-disc')?.classList.add('spinning');

      // Report the actual song duration to the server so it can schedule
      // the next song precisely. getDuration() is reliable once playing starts.
      const sendDurationReport = () => {
        const duration = Player.getDuration();
        if (duration > 10 && videoId && state.ws?.readyState === WebSocket.OPEN) {
          let totalDuration = duration;
          if (state.lastRjDuration && state.radioMode === 'request') {
            totalDuration += state.lastRjDuration;
          }
          state.ws.send(JSON.stringify({
            type:     'song_duration_report',
            video_id: videoId,
            duration: Math.round(totalDuration),
          }));
          console.log(`[Sync] Reported total duration: ${Math.round(totalDuration)}s for ${videoId}`);
          state.lastRjDuration = 0;
          return true;
        }
        return false;
      };

      if (!sendDurationReport()) {
        setTimeout(sendDurationReport, 1500);
        setTimeout(sendDurationReport, 3500);
      }
    });

    Player.onEnded(() => {
      // Song ended on this client — just update UI, wait for server's play_next.
      // DO NOT call song-ended or pick next song — the server controls this.
      console.log('[Client] Song ended locally — waiting for server play_next');
      $('cover-disc')?.classList.remove('spinning');
      // Keep isPlaying=true so when play_next arrives we auto-play
    });

    Player.onError((code) => {
      // YouTube error (e.g. video unavailable in this country).
      // Just log it — the server will advance after song_duration anyway.
      console.warn('[Player] YouTube error code:', code);
      $('cover-disc')?.classList.remove('spinning');
    });
  }


  // ── NOT async — must stay synchronous to keep user-gesture chain on mobile ──
  function _handlePlayPause() {
    if (state.isPlaying) {
      // Pause
      state.isPlaying = false;
      Player.pause();
      _updatePlayBtn(false);
      _stopEq();
      $('cover-disc')?.classList.remove('spinning');
      return;
    }

    // Play
    state.isPlaying = true;
    _updatePlayBtn(true);

    // Enforce global sync on play: Always reload the video at the current live offset.
    // This ensures no nanosecond delay across devices when a user "tunes in" after stopping.
    if (state.currentSong?.youtube_video_id) {
      const offset = _getSyncOffset();
      console.log(`[Sync] Play pressed — joining at ${offset.toFixed(1)}s`);
      _loadYTSong(state.currentSong, offset);
      _refreshSyncBackground();
      return;
    }

    // Fallback if no song is cached yet
    Player.play();
    _fetchFirstSong();
  }

  // Refresh sync offset in background after video is already playing.
  // Called AFTER the gesture — no autoplay restriction applies here.
  function _refreshSyncBackground() {
    fetch('/api/radio/state')
      .then(r => r.json())
      .then(data => {
        if (!data?.success || !data.state) return;
        const s = data.state;
        // Update clock drift
        if (s.server_time > 0) {
          state.clockDrift = s.server_time - (Date.now() / 1000);
        }
        if (s.song_started_at > 0) {
          state.songStartedAt = s.song_started_at;
        }
        // If the song changed while we were loading, seek to correct position
        if (s.current_song?.youtube_video_id === state.currentSong?.youtube_video_id) {
          const correctOffset = _getSyncOffset();
          if (correctOffset > 5) {
            // Only re-seek if we're significantly out of sync
            console.log(`[Sync] Background correction → ${correctOffset.toFixed(1)}s`);
            Player.loadVideo(s.current_song.youtube_video_id, true, correctOffset);
          }
        } else if (s.current_song) {
          // Server has moved on to a different song
          _loadYTSong(s.current_song, _getSyncOffset());
        }
      })
      .catch(() => {});
  }

  // Fetch first song when no state is cached yet (async — called after play unlock)
  function _fetchFirstSong() {
    fetch('/api/radio/song-ended', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data?.next) {
          if (data.next.started_at) state.songStartedAt = data.next.started_at;
          _handlePlayNext(data.next);
        } else {
          state.isPlaying = false;
          _updatePlayBtn(false);
        }
      })
      .catch(() => {
        state.isPlaying = false;
        _updatePlayBtn(false);
      });
  }


  // ── UI helpers ─────────────────────────────────────────────────────────────
  function _updateSongDisplay(song) {
    const nameEl   = $('track-name');
    const artistEl = $('track-artist');
    if (nameEl)   nameEl.textContent   = song.title || 'Delux Radio';
    if (artistEl) artistEl.textContent = [song.artist, song.movie].filter(Boolean).join(' · ');
    document.title = `${song.title} — Delux Radio 📻`;

    // YouTube thumbnail as vinyl cover art
    if (song.youtube_video_id) {
      const disc = $('cover-disc');
      if (disc) disc.style.backgroundImage = `url('https://img.youtube.com/vi/${song.youtube_video_id}/hqdefault.jpg')`;
    }
  }

  function _updatePlayBtn(playing) {
    const btn = $('btn-play');
    if (!btn) return;
    btn.textContent = playing ? '⏹' : '▶';
    btn.setAttribute('aria-label', playing ? 'Stop' : 'Play');
  }

  function _updateListeners(count) {
    const el = $('listener-count');
    if (el) el.textContent = Math.max(1, count);
  }

  function _updateModePill(mode) {
    const pill = $('mode-pill');
    const text = $('mode-text');
    if (!pill || !text) return;
    pill.className = `mode-pill ${mode}`;
    text.textContent = mode === 'request' ? 'REQUEST MODE' : 'AUTO RADIO';
  }

  function _updateQueue(queue) {
    const strip = $('queue-strip');
    if (!strip) return;
    if (!queue || !queue.length) {
      strip.classList.add('hidden');
    } else {
      strip.classList.remove('hidden');
      const names = queue.slice(0, 3)
        .map(r => {
          if (r.requester_name) {
            const dur = r.song?.duration ? ` (${_fmtTime(r.song.duration)})` : '';
            return `${r.requester_name} → ${r.song?.title || '…'}${dur}`;
          }
          const dur = r.duration ? ` (${_fmtTime(r.duration)})` : '';
          return `${r.title || '…'}${dur}`;
        })
        .join(', ');
      strip.innerHTML = `🎵 Up next: <strong>${names}</strong>${queue.length > 3 ? ` +${queue.length - 3} more` : ''}`;
    }
  }

  function _fmtTime(sec) {
    if (!sec || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function _updateProgressDisplay() {
    const timeEl = $('track-time');
    if (!timeEl) return;
    const dur = state.songDuration || state.currentSong?.duration || 0;
    if (!state.isPlaying || !state.songStartedAt) {
      timeEl.textContent = dur > 0 ? `· ${_fmtTime(dur)}` : '';
      return;
    }
    const elapsed = Math.max(0, _getSyncOffset());
    timeEl.textContent = dur > 0 ? `· ${_fmtTime(elapsed)} / ${_fmtTime(dur)}` : `· ${_fmtTime(elapsed)}`;
  }

  function _startProgressTick() {
    setInterval(_updateProgressDisplay, 1000);
  }

  function _updateUsernameDisplay() {
    const el = $('username-display');
    if (el) el.textContent = state.username || '—';
  }

  // ── RJ Banner ──────────────────────────────────────────────────────────────
  function _showRJBanner() {
    const b = $('rj-banner');
    if (!b) return;
    b.innerHTML = `
      <div class="rj-banner-label">🎙️ RJ ON AIR</div>
      <div class="rj-banner-text">Sit back — a special dedication is coming up…</div>`;
    b.classList.add('visible');
    $('cover-disc')?.classList.remove('spinning');
  }
  function _hideRJBanner() {
    $('rj-banner')?.classList.remove('visible');
    if (state.isPlaying) $('cover-disc')?.classList.add('spinning');
  }

  // ── Equalizer ──────────────────────────────────────────────────────────────
  function _startEq() { document.querySelectorAll('.eq-bar').forEach(b => b.classList.add('playing')); }
  function _stopEq()  { document.querySelectorAll('.eq-bar').forEach(b => b.classList.remove('playing')); }

  // ── Toasts ─────────────────────────────────────────────────────────────────
  function _showToast(title, body, type = 'info') {
    const container = $('toast-container');
    if (!container) return;
    const icons = { request: '🎵', request_incoming: '🎙️', info: 'ℹ️', success: '✅', error: '❌' };
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || '📻'}</span>
      <div class="toast-content">
        <div class="toast-title">${_esc(title || '')}</div>
        <div class="toast-body">${_esc(body || '')}</div>
      </div>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 400);
    }, 4500);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function _genId() { return Math.random().toString(36).substr(2, 9); }
  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
