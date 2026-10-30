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
    pingInterval:   null,  // Keepalive interval for tunnels/proxies
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
    // Automatically select wss:// when on https:// (Google Colab, Pinggy, Cloudflare, etc.)
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;
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
      console.log('[WS] Connected to Delux Radio');
      state.wsConnected = true;
      state.ws.send(JSON.stringify({ type: 'set_username', username: state.username }));

      // Immediately resync state upon connect / reconnect
      _fetchInitialState();

      // Start keep-alive ping heartbeat every 15s to prevent tunnels from timing out
      if (state.pingInterval) clearInterval(state.pingInterval);
      state.pingInterval = setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 15000);
    };
    state.ws.onmessage = e => {
      try { _handleWsMessage(JSON.parse(e.data)); } catch {}
    };
    state.ws.onclose = () => {
      state.wsConnected = false;
      if (state.pingInterval) {
        clearInterval(state.pingInterval);
        state.pingInterval = null;
      }
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

  // ── Song transitions & Sync Watchdog ───────────────────────────────────────
  let _lastSyncCheck = 0;
  function _checkServerSongSync() {
    const now = Date.now();
    if (now - _lastSyncCheck < 2000) return;
    _lastSyncCheck = now;

    fetch('/api/radio/state')
      .then(r => r.json())
      .then(d => {
        if (!d?.success || !d.state) return;
        const s = d.state;
        _applyRadioState(s);

        if (state.isPlaying && s.current_song && state.currentSong &&
            s.current_song.youtube_video_id !== state.currentSong.youtube_video_id) {
          console.log('[Sync] Server song change detected via sync check');
          _handlePlayNext({
            type: s.mode,
            song: s.current_song,
            started_at: s.song_started_at,
            rj_audio_url: s.rj_audio_url
          });
        }
      })
      .catch(() => {});
  }

  function _onYTSongEnded() {
    if (!state.isPlaying) return;
    fetch('/api/radio/song-ended', { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        if (d?.next) _handlePlayNext(d.next);
        else _checkServerSongSync();
      })
      .catch(() => _checkServerSongSync());
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


  // ── Mobile Background Playback & MediaSession Helpers ────────────────────
  let wakeLock = null;
  async function _requestWakeLock() {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch (err) {}
    }
  }
  function _releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  function _initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        if (!state.isPlaying) _handlePlayPause();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (state.isPlaying) _handlePlayPause();
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        if (state.isPlaying) _handlePlayPause();
      });
    } catch (e) {
      console.warn('[MediaSession] Handler setup error:', e);
    }
  }

  function _updateMediaSession(song, isPlaying = true) {
    if (!('mediaSession' in navigator)) return;
    try {
      const title = song?.title || 'Delux Radio';
      const artist = song?.artist || '90s Bollywood Nonstop';
      const artwork = song?.thumbnail || `${location.origin}/assets/logo.png`;

      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        album: 'Delux Radio Live',
        artwork: [
          { src: artwork, sizes: '96x96', type: 'image/jpeg' },
          { src: artwork, sizes: '128x128', type: 'image/jpeg' },
          { src: artwork, sizes: '192x192', type: 'image/jpeg' },
          { src: artwork, sizes: '256x256', type: 'image/jpeg' },
          { src: artwork, sizes: '512x512', type: 'image/jpeg' }
        ]
      });

      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch (e) {
      console.warn('[MediaSession] Metadata update error:', e);
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
    _updateMediaSession(song, true);
    _updatePlayBtn(true);
    _startEq();
    $('cover-disc')?.classList.add('spinning');

    // Clamp offset — don't seek beyond song duration
    const maxSeek = (song.duration || state.songDuration || 600);
    const seekTo = Math.min(Math.max(0, startSeconds), maxSeek);
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
        if (duration > 10 && videoId) {
          let totalDuration = duration;
          if (state.lastRjDuration && state.radioMode === 'request') {
            totalDuration += state.lastRjDuration;
          }
          const roundedDur = Math.round(totalDuration);

          // 1. Report via WebSocket if open
          if (state.ws?.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
              type:     'song_duration_report',
              video_id: videoId,
              duration: roundedDur,
            }));
          }

          // 2. Also report via REST endpoint (ensures Colab/tunnel always has exact duration)
          fetch('/api/radio/duration', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_id: videoId, duration: roundedDur })
          }).catch(() => {});

          console.log(`[Sync] Reported total duration: ${roundedDur}s for ${videoId}`);
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
      console.log('[Client] Song ended locally — coordinating next song');
      $('cover-disc')?.classList.remove('spinning');

      if (!state.isPlaying) return;

      // Give server auto-loop 1.5s buffer to broadcast play_next; if delayed, query server
      setTimeout(() => {
        if (!state.isPlaying) return;
        fetch('/api/radio/song-ended', { method: 'POST' })
          .then(r => r.json())
          .then(d => {
            if (d?.next) {
              _handlePlayNext(d.next);
            } else {
              _checkServerSongSync();
            }
          })
          .catch(() => _checkServerSongSync());
      }, 1500);
    });

    Player.onError((code) => {
      console.warn('[Player] Audio/Visual error code:', code);
      $('cover-disc')?.classList.remove('spinning');
      if (state.isPlaying) {
        // If error persists, trigger watchdog check to keep station moving
        setTimeout(() => {
          if (state.isPlaying) _checkServerSongSync();
        }, 3000);
      }
    // ── Mobile Background Playback & Visibility ─────────────────────────
    _initMediaSession();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        console.log('[App] Document minimized/hidden — keeping audio active');
        if (state.isPlaying) {
          Player.keepPlaying();
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
          }
        }
      } else {
        console.log('[App] Document restored to foreground');
        if (state.isPlaying) {
          _requestWakeLock();
          _startEq();
          $('cover-disc')?.classList.add('spinning');
          _checkServerSongSync();
        }
      }
    });
  }


  // ── NOT async — must stay synchronous to keep user-gesture chain on mobile ──
  function _handlePlayPause() {
    // Unblock AudioContext immediately within user gesture chain
    Player.initKeepAlive();

    if (state.isPlaying) {
      // Pause
      state.isPlaying = false;
      Player.pause();
      _releaseWakeLock();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
      _updatePlayBtn(false);
      _stopEq();
      $('cover-disc')?.classList.remove('spinning');
      return;
    }

    // Play
    state.isPlaying = true;
    _requestWakeLock();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
      if (state.currentSong) _updateMediaSession(state.currentSong, true);
    }
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

  // Fetch current radio state and start playing (async — called after play unlock)
  function _fetchFirstSong() {
    fetch('/api/radio/state')
      .then(r => r.json())
      .then(data => {
        if (!data?.success || !data.state) {
          state.isPlaying = false;
          _updatePlayBtn(false);
          return;
        }
        _applyRadioState(data.state);
        if (state.currentSong?.youtube_video_id) {
          const offset = _getSyncOffset();
          console.log(`[Sync] First play — joining at ${offset.toFixed(1)}s`);
          _loadYTSong(state.currentSong, offset);
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

    // Sync watchdog: if local playback elapsed exceeds duration + 4s, verify server state
    if (dur > 10 && elapsed >= dur + 4) {
      _checkServerSongSync();
    }
  }

  function _startProgressTick() {
    let lastPoll = 0;
    setInterval(() => {
      _updateProgressDisplay();
      // If WebSocket is not connected, poll every 5s to keep listeners count and queue alive
      const now = Date.now();
      if (!state.wsConnected && (now - lastPoll > 5000)) {
        lastPoll = now;
        _checkServerSongSync();
      }
    }, 1000);
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
