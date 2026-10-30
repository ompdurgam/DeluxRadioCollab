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
  // DO NOT use crossOrigin attribute, googlevideo redirect does not send CORS
  
  // ── Web Audio API Keep-Alive Anchor (Chrome Android background audio protection) ──
  let keepAliveCtx = null;
  let keepAliveGain = null;

  function _initKeepAlive() {
    if (keepAliveCtx) {
      if (keepAliveCtx.state === 'suspended') {
        keepAliveCtx.resume().catch(() => {});
      }
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

      keepAliveGain = keepAliveCtx.createGain();
      keepAliveGain.gain.value = 0.0001; // Inaudible, but flags active output to Chrome/Android audio subsystem

      source.connect(keepAliveGain);
      keepAliveGain.connect(keepAliveCtx.destination);
      source.start(0);

      if (keepAliveCtx.state === 'suspended') {
        keepAliveCtx.resume().catch(() => {});
      }
      console.log('[Player] Web Audio background keep-alive active');
    } catch (e) {
      console.warn('[Player] Keep-alive setup notice:', e);
    }
  }

  let pendingVideoId = null;
  let pendingPlay = false;
  let pendingStart = 0;
  let currentVideoId = null;
  let audioRetryCount = 0;

  // Callbacks
  let _onEndedCb = null;
  let _onPlayingCb = null;
  let _onErrorCb = null;

  function _fallbackToYouTubeAudio(autoplay = true) {
    // NEVER switch to YouTube iframe audio if page is hidden/minimized because YouTube iframes are killed by Chrome in background
    if (document.hidden) {
      console.log('[Player] Suppressed YouTube fallback: page is minimized, retrying direct audio stream');
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
      if (autoplay) {
        ytPlayer.playVideo();
      }
      console.log('[Player] Switched to YouTube iframe audio fallback');
      if (_onPlayingCb) _onPlayingCb(currentVideoId);
    } catch (e) {
      console.warn('[Player] YouTube audio fallback error:', e);
    }
  }

  // ── Audio Events ──
  audioPlayer.addEventListener('playing', () => {
    console.log('[Player] Audio Playing');
    audioRetryCount = 0;
    if (_onPlayingCb) _onPlayingCb(currentVideoId);
  });

  audioPlayer.addEventListener('ended', () => {
    console.log('[Player] Audio Ended');
    if (_onEndedCb) _onEndedCb();
  });

  audioPlayer.addEventListener('error', (e) => {
    console.warn('[Player] Audio stream error:', e);
    if (audioRetryCount < 2 && currentVideoId) {
      audioRetryCount++;
      console.log(`[Player] Retrying direct audio stream (attempt ${audioRetryCount})...`);
      setTimeout(() => {
        audioPlayer.src = `/api/radio/stream/${currentVideoId}?retry=${audioRetryCount}`;
        audioPlayer.load();
        audioPlayer.play().catch(() => {});
      }, 1000);
      return;
    }
    // Only fallback if visible and not on background
    if (!document.hidden) {
      _fallbackToYouTubeAudio(true);
    }
    if (_onErrorCb) _onErrorCb(5); 
  });

  // ── YouTube Visuals ──
  window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('yt-player', {
      height: '100%',
      width: '100%',
      videoId: '',
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        iv_load_policy: 3,
        modestbranding: 1,
        rel: 0,
        showinfo: 0,
        playsinline: 1,
        mute: 1, // Start muted; unmuted if audioPlayer fails
        origin: location.origin,
      },
      events: {
        onReady: (event) => {
          isReady = true;
          if (!usingYtAudio) {
            event.target.mute();
          } else {
            event.target.unMute();
            event.target.setVolume(currentVolume);
          }
          console.log('[Player] YouTube Player ready');
          if (pendingVideoId) {
            _doLoad(pendingVideoId, pendingPlay, pendingStart);
            pendingVideoId = null;
          }
        },
        onStateChange: (event) => {
          // YT.PlayerState.ENDED is 0
          if (event.data === 0) {
            console.log('[Player] YouTube video ended');
            if (_onEndedCb) _onEndedCb();
          } else if (event.data === 1 && usingYtAudio) {
            // YT.PlayerState.PLAYING is 1
            if (_onPlayingCb) _onPlayingCb(currentVideoId);
          }
        },
        onError: (e) => {
          console.warn('[Player] YouTube error code:', e.data);
          if (_onErrorCb) _onErrorCb(e.data);
        }
      },
    });
  };

  function _doLoad(videoId, autoplay, startSeconds) {
    currentVideoId = videoId;
    _initKeepAlive();
    usingYtAudio = false; // Reset per song; default to HTML5 direct stream for background play
    
    // 1. Update Audio — must wait for loadedmetadata before seeking
    audioPlayer.src = `/api/radio/stream/${videoId}`;
    audioPlayer.load();
    
    const seekAndPlay = () => {
      if (startSeconds > 0 && isFinite(audioPlayer.duration) && audioPlayer.duration > 1) {
        try { audioPlayer.currentTime = Math.min(startSeconds, Math.max(0, audioPlayer.duration - 1)); }
        catch (e) { console.warn('[Player] Seek failed:', e); }
      }
      if (autoplay) {
        const p = audioPlayer.play();
        if (p && typeof p.catch === 'function') {
          p.catch(e => {
            console.warn("[Player] Audio play notice:", e.message || e);
            // On mobile background or document.hidden, never switch to YouTube iframe because YouTube iframe stops in background
            if (!document.hidden && (!e || e.name !== 'AbortError')) {
              _fallbackToYouTubeAudio(autoplay);
            }
          });
        }
      }
    };
    
    // If metadata is already loaded (cached), seek immediately
    if (audioPlayer.readyState >= 1 && isFinite(audioPlayer.duration)) {
      seekAndPlay();
    } else {
      audioPlayer.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      // Fallback: if loadedmetadata never fires (some streams), play after timeout
      setTimeout(() => {
        if (autoplay && audioPlayer.paused && !usingYtAudio) {
          audioPlayer.play().catch(() => {
            if (!document.hidden) _fallbackToYouTubeAudio(autoplay);
          });
        }
      }, 2500);
    }

    // 2. Update Visuals
    if (ytPlayer && isReady) {
      try {
        ytPlayer.mute();
        const opts = startSeconds > 0 ? { videoId, startSeconds: Math.floor(startSeconds) } : videoId;
        if (autoplay) {
          ytPlayer.loadVideoById(opts);
        } else {
          ytPlayer.cueVideoById(opts);
        }
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
      currentVideoId = videoId;
      usingYtAudio = false;
      audioPlayer.src = `/api/radio/stream/${videoId}`;
      audioPlayer.load();
      
      const seekAndPlay = () => {
        if (startSeconds > 0 && isFinite(audioPlayer.duration) && audioPlayer.duration > 1) {
          try { audioPlayer.currentTime = Math.min(startSeconds, Math.max(0, audioPlayer.duration - 1)); }
          catch (e) { /* ignore */ }
        }
        if (autoplay) {
          audioPlayer.play().catch(() => {
            if (!document.hidden) _fallbackToYouTubeAudio(autoplay);
          });
        }
      };
      
      if (audioPlayer.readyState >= 1 && isFinite(audioPlayer.duration)) {
        seekAndPlay();
      } else {
        audioPlayer.addEventListener('loadedmetadata', seekAndPlay, { once: true });
        setTimeout(() => {
          if (autoplay && audioPlayer.paused && !usingYtAudio) {
            audioPlayer.play().catch(() => {
              if (!document.hidden) _fallbackToYouTubeAudio(autoplay);
            });
          }
        }, 2500);
      }
      
      pendingVideoId = videoId;
      pendingPlay = autoplay;
      pendingStart = startSeconds;
      return;
    }

    _doLoad(videoId, autoplay, startSeconds);
  }

  function play() {
    _initKeepAlive();
    if (usingYtAudio && isReady && ytPlayer && !document.hidden) {
      try { ytPlayer.playVideo(); } catch {}
    } else {
      usingYtAudio = false;
      audioPlayer.play().catch(e => {
        if (!document.hidden) _fallbackToYouTubeAudio(true);
      });
      if (isReady && ytPlayer && !document.hidden) {
        try {
          ytPlayer.mute();
          ytPlayer.playVideo();
        } catch {}
      }
    }
  }

  function pause() {
    audioPlayer.pause();
    if (isReady && ytPlayer) {
      try { ytPlayer.pauseVideo(); } catch {}
    }
  }

  function keepPlaying() {
    _initKeepAlive();
    if (audioPlayer.paused && currentVideoId && !usingYtAudio) {
      console.log('[Player] Resuming HTML5 direct audio in background');
      const p = audioPlayer.play();
      if (p && typeof p.catch === 'function') {
        p.catch(e => console.warn('[Player] keepPlaying notice:', e.message || e));
      }
    }
  }

  function initKeepAlive() {
    _initKeepAlive();
  }

  function setVolume(vol) {
    currentVolume = Math.max(0, Math.min(100, vol));
    audioPlayer.volume = currentVolume / 100;
    if (isReady && ytPlayer) {
      try { ytPlayer.setVolume(currentVolume); } catch {}
    }
  }

  function setMuted(muted) {
    currentMuted = !!muted;
    audioPlayer.muted = currentMuted;
    if (isReady && ytPlayer) {
      try {
        if (currentMuted || !usingYtAudio) ytPlayer.mute();
        else ytPlayer.unMute();
      } catch {}
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
      } catch { return 0; }
    }
    return 0;
  }

  function onEnded(cb) { _onEndedCb = cb; }
  function onPlaying(cb) { _onPlayingCb = cb; }
  function onError(cb) { _onErrorCb = cb; }

  return {
    loadVideo,
    play,
    pause,
    keepPlaying,
    initKeepAlive,
    setVolume,
    setMuted,
    isPlaying,
    getDuration,
    onEnded,
    onPlaying,
    onError,
  };
})();

// Inject YouTube IFrame API script
(function () {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.async = true;
  const first = document.getElementsByTagName('script')[0];
  first.parentNode.insertBefore(tag, first);
})();
