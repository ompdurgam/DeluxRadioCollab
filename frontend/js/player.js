/**
 * YouTube IFrame Player & Direct Audio Stream Integration — Delux Radio
 * Manages YouTube player state (for ambient visuals) and HTML5 Audio (for sound).
 */

const Player = (() => {
  // YouTube Visual Player
  let ytPlayer = null;
  let isReady = false;
  let usingYtAudio = false;
  let currentVolume = 80;
  let currentMuted = false;

  // HTML5 Audio Player (Bypasses mobile restrictions and enables background play)
  const audioPlayer = new Audio();
  audioPlayer.preload = 'auto';
  audioPlayer.setAttribute('playsinline', 'true');
  audioPlayer.setAttribute('webkit-playsinline', 'true');

  // ── Web Audio API Keep-Alive Anchor (Chrome Android background audio protection) ──
  let keepAliveCtx = null;

  function _initKeepAlive() {
    if (keepAliveCtx) {
      if (keepAliveCtx.state === 'suspended') keepAliveCtx.resume().catch(() => {});
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      keepAliveCtx = new AudioCtx();

      // Silent buffer looped continuously to keep Android AudioFlinger hardware stream alive
      const buffer = keepAliveCtx.createBuffer(1, keepAliveCtx.sampleRate * 0.5, keepAliveCtx.sampleRate);
      const source = keepAliveCtx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const gain = keepAliveCtx.createGain();
      gain.gain.value = 0.0001; // Inaudible but flags active output to Android audio subsystem

      source.connect(gain);
      gain.connect(keepAliveCtx.destination);
      source.start(0);

      if (keepAliveCtx.state === 'suspended') keepAliveCtx.resume().catch(() => {});
    } catch (e) {
      console.warn('[Player] Keep-alive setup notice:', e);
    }
  }

  let pendingVideoId = null;
  let pendingPlay = false;
  let pendingStart = 0;
  let currentVideoId = null;

  // Callbacks
  let _onEndedCb = null;
  let _onPlayingCb = null;
  let _onErrorCb = null;

  function _fallbackToYouTubeAudio(autoplay = true) {
    // Never switch to YouTube iframe if page is minimised — Chrome kills iframes in background
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
      audioPlayer.pause();
      if (!currentMuted) {
        ytPlayer.unMute();
        ytPlayer.setVolume(currentVolume);
      }
      if (autoplay) ytPlayer.playVideo();
      if (_onPlayingCb) _onPlayingCb(currentVideoId);
    } catch (e) {
      console.warn('[Player] YouTube audio fallback error:', e);
    }
  }

  // ── Audio Events ──
  audioPlayer.addEventListener('playing', () => {
    usingYtAudio = false;
    if (ytPlayer && isReady) { try { ytPlayer.mute(); } catch {} }
    if (_onPlayingCb) _onPlayingCb(currentVideoId);
  });

  audioPlayer.addEventListener('ended', () => {
    if (_onEndedCb) _onEndedCb();
  });

  audioPlayer.addEventListener('error', () => {
    _fallbackToYouTubeAudio(true);
    if (_onErrorCb) _onErrorCb(5);
  });

  // ── YouTube Visuals ──
  window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('yt-player', {
      height: '100%',
      width: '100%',
      videoId: '',
      playerVars: {
        autoplay: 0, controls: 0, disablekb: 1, fs: 0,
        iv_load_policy: 3, modestbranding: 1, rel: 0,
        showinfo: 0, playsinline: 1,
        mute: 1,
        origin: location.origin,
      },
      events: {
        onReady: (event) => {
          isReady = true;
          usingYtAudio ? event.target.unMute() && event.target.setVolume(currentVolume)
                       : event.target.mute();
          if (pendingVideoId) {
            _doLoad(pendingVideoId, pendingPlay, pendingStart);
            pendingVideoId = null;
          }
        },
        onStateChange: (event) => {
          if (event.data === 0 && _onEndedCb) _onEndedCb();           // ENDED
          else if (event.data === 1 && usingYtAudio && _onPlayingCb)  // PLAYING
            _onPlayingCb(currentVideoId);
        },
        onError: (e) => { if (_onErrorCb) _onErrorCb(e.data); }
      },
    });
  };

  function _doLoad(videoId, autoplay, startSeconds) {
    currentVideoId = videoId;
    _initKeepAlive();
    usingYtAudio = false;

    // 1. HTML5 audio — seek once metadata is ready
    audioPlayer.src = `/api/radio/stream/${videoId}`;
    audioPlayer.load();

    const seekAndPlay = () => {
      if (startSeconds > 0 && isFinite(audioPlayer.duration) && audioPlayer.duration > 1) {
        try { audioPlayer.currentTime = Math.min(startSeconds, audioPlayer.duration - 1); }
        catch (e) { console.warn('[Player] Seek failed:', e); }
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
      // Fallback: some streams never fire loadedmetadata — play after 2.5s
      setTimeout(() => {
        if (autoplay && audioPlayer.paused && !usingYtAudio) {
          audioPlayer.play().catch(() => { if (!document.hidden) _fallbackToYouTubeAudio(autoplay); });
        }
      }, 2500);
    }

    // 2. YouTube visuals (muted)
    if (ytPlayer && isReady) {
      try {
        ytPlayer.mute();
        const opts = startSeconds > 0 ? { videoId, startSeconds: Math.floor(startSeconds) } : videoId;
        autoplay ? ytPlayer.loadVideoById(opts) : ytPlayer.cueVideoById(opts);
      } catch (e) {
        console.warn('[Player] Failed to load visual video:', e);
      }
    }
  }

  // ── Public API ──

  function loadVideo(videoId, autoplay = true, startSeconds = 0) {
    if (!videoId) return;
    _initKeepAlive();
    if (!isReady) {
      // Queue until YT player is ready; still start audio immediately
      pendingVideoId = videoId;
      pendingPlay = autoplay;
      pendingStart = startSeconds;
    }
    _doLoad(videoId, autoplay, startSeconds);
  }

  function play() {
    _initKeepAlive();
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
    audioPlayer.pause();
    if (isReady && ytPlayer) { try { ytPlayer.pauseVideo(); } catch {} }
  }

  function keepPlaying() {
    _initKeepAlive();
    if (audioPlayer.paused && currentVideoId && !usingYtAudio) {
      audioPlayer.play().catch(e => console.warn('[Player] keepPlaying notice:', e?.message || e));
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
      try { return ytPlayer.getPlayerState() === 1; } catch { return false; }
    }
    return !audioPlayer.paused && audioPlayer.currentTime > 0;
  }

  function getDuration() {
    const d = audioPlayer.duration;
    if (d && !isNaN(d) && isFinite(d) && d > 10) return d;
    if (isReady && ytPlayer) {
      try {
        const yd = ytPlayer.getDuration();
        if (yd && !isNaN(yd) && isFinite(yd) && yd > 10) return yd;
      } catch {}
    }
    return 0;
  }

  function onEnded(cb)  { _onEndedCb  = cb; }
  function onPlaying(cb){ _onPlayingCb = cb; }
  function onError(cb)  { _onErrorCb  = cb; }

  return { loadVideo, play, pause, keepPlaying, initKeepAlive, setVolume, setMuted, isPlaying, getDuration, onEnded, onPlaying, onError };
})();

// Inject YouTube IFrame API script
(function () {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.async = true;
  document.head.appendChild(tag);
})();
