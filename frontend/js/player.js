/**
 * YouTube IFrame Player & Direct Audio Stream Integration — Delux Radio
 *
 * BACKGROUND AUDIO STRATEGY (Chrome / Android):
 *   1. HTML5 <audio> plays the real stream (via backend proxy).
 *   2. AudioContext routes audioPlayer through createMediaElementSource — fusing
 *      both into ONE OS audio session so Chrome never suspends the stream.
 *   3. Silent looped buffer keeps the AudioContext output active (prevents OS
 *      from closing the audio hardware session when screen locks).
 *   4. MediaSession API sets metadata + playbackState so the Android lock-screen
 *      widget appears with artwork and controls.
 *   5. _userPaused flag distinguishes user-initiated pauses from Chrome-forced
 *      background pauses; auto-resume fires on the latter.
 */

const Player = (() => {
  // YouTube Visual Player (visuals only — audio comes from audioPlayer)
  let ytPlayer     = null;
  let isReady      = false;
  let usingYtAudio = false;
  let currentVolume = 80;
  let currentMuted  = false;

  // ── HTML5 Audio (real audio source) ──────────────────────────────────────────
  const audioPlayer = new Audio();
  audioPlayer.preload = 'auto';
  audioPlayer.setAttribute('playsinline', 'true');
  audioPlayer.setAttribute('webkit-playsinline', 'true');
  audioPlayer.setAttribute('x-webkit-airplay', 'allow');

  // ── Web Audio Keep-Alive ──────────────────────────────────────────────────────
  let keepAliveCtx = null;
  let mediaElemSrc = null; // MediaElementSourceNode wrapping audioPlayer

  function _initKeepAlive() {
    // Resume if context was suspended
    if (keepAliveCtx) {
      if (keepAliveCtx.state === 'suspended') keepAliveCtx.resume().catch(() => {});
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      keepAliveCtx = new AudioCtx();

      // Wire audioPlayer into this AudioContext so they share ONE OS audio session.
      // NOTE: createMediaElementSource can only be called once per element.
      if (!mediaElemSrc) {
        try {
          mediaElemSrc = keepAliveCtx.createMediaElementSource(audioPlayer);
          mediaElemSrc.connect(keepAliveCtx.destination);
        } catch (e) {
          // Already created, or unsupported — fine, we still have the buffer keep-alive
          mediaElemSrc = null;
        }
      }

      // Silent looped buffer — keeps the AudioContext hardware stream open.
      // Without this Chrome/Android closes the session when screen locks.
      const silentBuf = keepAliveCtx.createBuffer(1, keepAliveCtx.sampleRate, keepAliveCtx.sampleRate);
      const silentSrc = keepAliveCtx.createBufferSource();
      silentSrc.buffer = silentBuf;
      silentSrc.loop   = true;

      const silentGain      = keepAliveCtx.createGain();
      silentGain.gain.value = 0.00001; // fully inaudible

      silentSrc.connect(silentGain);
      silentGain.connect(keepAliveCtx.destination);
      silentSrc.start(0);

      if (keepAliveCtx.state === 'suspended') keepAliveCtx.resume().catch(() => {});
    } catch (e) {
      console.warn('[Player] Keep-alive init:', e?.message);
    }
  }

  // ── Auto-resume on forced background pause ───────────────────────────────────
  // Chrome may fire 'pause' when page hides. Re-play unless user paused it.
  let _userPaused  = false;
  let _resumeTimer = null;

  audioPlayer.addEventListener('pause', () => {
    if (_userPaused || !currentVideoId) return;
    clearTimeout(_resumeTimer);
    _resumeTimer = setTimeout(() => {
      if (!_userPaused && audioPlayer.paused && currentVideoId) {
        audioPlayer.play().catch(() => {});
        if (keepAliveCtx?.state === 'suspended') keepAliveCtx.resume().catch(() => {});
      }
    }, 500);
  });

  let pendingVideoId = null;
  let pendingPlay    = false;
  let pendingStart   = 0;
  let currentVideoId = null;

  // Callbacks
  let _onEndedCb   = null;
  let _onPlayingCb  = null;
  let _onErrorCb    = null;

  // ── Fallback to YouTube iframe audio ─────────────────────────────────────────
  function _fallbackToYouTubeAudio(autoplay = true) {
    // Never switch to YT iframe when minimised — Chrome kills iframes in background
    if (document.hidden) {
      if (currentVideoId && autoplay) {
        audioPlayer.src = `/api/radio/stream/${currentVideoId}?t=${Date.now()}`;
        audioPlayer.load();
        audioPlayer.play().catch(() => {});
      }
      return;
    }
    if (!isReady || !ytPlayer) return;
    try {
      usingYtAudio = true;
      _userPaused = true;
      audioPlayer.pause();
      _userPaused = false;
      if (!currentMuted) { ytPlayer.unMute(); ytPlayer.setVolume(currentVolume); }
      if (autoplay) ytPlayer.playVideo();
      if (_onPlayingCb) _onPlayingCb(currentVideoId);
    } catch (e) {
      console.warn('[Player] YT fallback error:', e);
    }
  }

  // ── Audio element events ──────────────────────────────────────────────────────
  audioPlayer.addEventListener('playing', () => {
    usingYtAudio = false;
    clearTimeout(_resumeTimer);
    if (ytPlayer && isReady) { try { ytPlayer.mute(); } catch {} }
    if (_onPlayingCb) _onPlayingCb(currentVideoId);
    // Ensure Android lock screen knows audio is active
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });

  audioPlayer.addEventListener('ended', () => {
    if (_onEndedCb) _onEndedCb();
  });

  audioPlayer.addEventListener('error', () => {
    if (!_userPaused) {
      _fallbackToYouTubeAudio(true);
      if (_onErrorCb) _onErrorCb(5);
    }
  });

  // ── YouTube Visuals (always muted) ───────────────────────────────────────────
  window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('yt-player', {
      height: '100%', width: '100%', videoId: '',
      playerVars: {
        autoplay: 0, controls: 0, disablekb: 1, fs: 0,
        iv_load_policy: 3, modestbranding: 1, rel: 0,
        showinfo: 0, playsinline: 1, mute: 1,
        origin: location.origin,
      },
      events: {
        onReady: (event) => {
          isReady = true;
          event.target.mute(); // always muted; audio is from audioPlayer
          if (pendingVideoId) {
            _doLoad(pendingVideoId, pendingPlay, pendingStart);
            pendingVideoId = null;
          }
        },
        onStateChange: (event) => {
          if (event.data === 0 && _onEndedCb) _onEndedCb();
          else if (event.data === 1 && usingYtAudio && _onPlayingCb) _onPlayingCb(currentVideoId);
        },
        onError: (e) => { if (_onErrorCb) _onErrorCb(e.data); }
      },
    });
  };

  // ── Core load ────────────────────────────────────────────────────────────────
  function _doLoad(videoId, autoplay, startSeconds) {
    currentVideoId = videoId;
    _initKeepAlive();
    usingYtAudio = false;
    _userPaused  = false;

    // 1. HTML5 audio stream
    audioPlayer.src = `/api/radio/stream/${videoId}`;
    audioPlayer.load();

    const seekAndPlay = () => {
      if (startSeconds > 0 && isFinite(audioPlayer.duration) && audioPlayer.duration > 1) {
        try { audioPlayer.currentTime = Math.min(startSeconds, audioPlayer.duration - 1); }
        catch (e) {}
      }
      if (autoplay) {
        audioPlayer.play().catch(e => {
          if (!document.hidden && e?.name !== 'AbortError') _fallbackToYouTubeAudio(autoplay);
        });
      }
    };

    if (audioPlayer.readyState >= 1 && isFinite(audioPlayer.duration)) {
      seekAndPlay();
    } else {
      audioPlayer.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      // Safety fallback if loadedmetadata never fires
      setTimeout(() => {
        if (autoplay && audioPlayer.paused && !usingYtAudio) {
          audioPlayer.play().catch(() => { if (!document.hidden) _fallbackToYouTubeAudio(autoplay); });
        }
      }, 2500);
    }

    // 2. YouTube visuals (muted — purely decorative)
    if (ytPlayer && isReady) {
      try {
        ytPlayer.mute();
        const opts = startSeconds > 0 ? { videoId, startSeconds: Math.floor(startSeconds) } : videoId;
        autoplay ? ytPlayer.loadVideoById(opts) : ytPlayer.cueVideoById(opts);
      } catch (e) {}
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  function loadVideo(videoId, autoplay = true, startSeconds = 0) {
    if (!videoId) return;
    _initKeepAlive();
    if (!isReady) { pendingVideoId = videoId; pendingPlay = autoplay; pendingStart = startSeconds; }
    _doLoad(videoId, autoplay, startSeconds);
  }

  function play() {
    _initKeepAlive();
    _userPaused = false;
    if (usingYtAudio && isReady && ytPlayer && !document.hidden) {
      try { ytPlayer.playVideo(); } catch {}
    } else {
      usingYtAudio = false;
      audioPlayer.play().catch(() => { if (!document.hidden) _fallbackToYouTubeAudio(true); });
      if (isReady && ytPlayer && !document.hidden) {
        try { ytPlayer.mute(); ytPlayer.playVideo(); } catch {}
      }
    }
  }

  function pause() {
    _userPaused = true;
    clearTimeout(_resumeTimer);
    audioPlayer.pause();
    if (isReady && ytPlayer) { try { ytPlayer.pauseVideo(); } catch {} }
  }

  function keepPlaying() {
    _initKeepAlive();
    _userPaused = false;
    if (keepAliveCtx?.state === 'suspended') keepAliveCtx.resume().catch(() => {});
    if (audioPlayer.paused && currentVideoId && !usingYtAudio) {
      audioPlayer.play().catch(() => {});
    }
  }

  function initKeepAlive() { _initKeepAlive(); }

  function setVolume(vol) {
    currentVolume = Math.max(0, Math.min(100, vol));
    audioPlayer.volume = currentVolume / 100;
    if (isReady && ytPlayer) { try { ytPlayer.setVolume(currentVolume); } catch {} }
  }

  function setMuted(muted) {
    currentMuted = !!muted;
    audioPlayer.muted = currentMuted;
    if (isReady && ytPlayer) {
      try { (currentMuted || !usingYtAudio) ? ytPlayer.mute() : ytPlayer.unMute(); } catch {}
    }
  }

  function isPlaying() {
    if (usingYtAudio && isReady && ytPlayer && !document.hidden) {
      try { return ytPlayer.getPlayerState() === 1; } catch {}
    }
    return !audioPlayer.paused && audioPlayer.currentTime > 0;
  }

  function getDuration() {
    const d = audioPlayer.duration;
    if (d && !isNaN(d) && isFinite(d) && d > 10) return d;
    if (isReady && ytPlayer) {
      try { const yd = ytPlayer.getDuration(); if (yd && !isNaN(yd) && isFinite(yd) && yd > 10) return yd; } catch {}
    }
    return 0;
  }

  function onEnded(cb)   { _onEndedCb   = cb; }
  function onPlaying(cb) { _onPlayingCb  = cb; }
  function onError(cb)   { _onErrorCb    = cb; }

  return { loadVideo, play, pause, keepPlaying, initKeepAlive, setVolume, setMuted, isPlaying, getDuration, onEnded, onPlaying, onError };
})();

// Inject YouTube IFrame API script
(function () {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.async = true;
  document.head.appendChild(tag);
})();
