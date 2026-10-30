/**
 * YouTube IFrame Player & Direct Audio Stream Integration — Delux Radio
 * Manages YouTube player state (for ambient visuals) and HTML5 Audio (for sound).
 */

const Player = (() => {
  // YouTube Visual Player
  let ytPlayer = null;
  let isReady = false;
  
  // HTML5 Audio Player (Bypasses mobile restrictions)
  const audioPlayer = new Audio();
  // DO NOT use crossOrigin attribute, googlevideo redirect does not send CORS
  
  let pendingVideoId = null;
  let pendingPlay = false;
  let pendingStart = 0;
  let currentVideoId = null;

  // Callbacks
  let _onEndedCb = null;
  let _onPlayingCb = null;
  let _onErrorCb = null;

  // ── Audio Events ──
  audioPlayer.addEventListener('playing', () => {
    console.log('[Player] Audio Playing');
    if (_onPlayingCb) _onPlayingCb(currentVideoId);
  });

  audioPlayer.addEventListener('ended', () => {
    console.log('[Player] Audio Ended');
    if (_onEndedCb) _onEndedCb();
  });

  audioPlayer.addEventListener('error', (e) => {
    console.warn('[Player] Audio Error:', e);
    // If audio fails, notify the app to advance
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
        mute: 1, // ALWAYS MUTED - We use HTML5 Audio for sound
        origin: location.origin,
      },
      events: {
        onReady: (event) => {
          isReady = true;
          event.target.mute(); // Enforce mute
          console.log('[Player] YouTube Visuals ready');
          if (pendingVideoId) {
            _doLoad(pendingVideoId, pendingPlay, pendingStart);
            pendingVideoId = null;
          }
        },
        onError: (e) => {
          console.warn('[Player] Visual YouTube error (Ignored):', e.data);
          // We intentionally ignore visual errors (like 150) because audioPlayer handles the music!
        }
      },
    });
  };

  function _doLoad(videoId, autoplay, startSeconds) {
    currentVideoId = videoId;
    
    // 1. Update Audio — must wait for loadedmetadata before seeking
    audioPlayer.src = `/api/radio/stream/${videoId}`;
    audioPlayer.load();
    
    const seekAndPlay = () => {
      if (startSeconds > 0 && isFinite(audioPlayer.duration) && audioPlayer.duration > 0) {
        try { audioPlayer.currentTime = Math.min(startSeconds, audioPlayer.duration - 1); }
        catch (e) { console.warn('[Player] Seek failed:', e); }
      }
      if (autoplay) {
        audioPlayer.play().catch(e => {
          console.warn("[Player] Audio blocked by browser:", e);
        });
      }
    };
    
    // If metadata is already loaded (cached), seek immediately
    if (audioPlayer.readyState >= 1 && isFinite(audioPlayer.duration)) {
      seekAndPlay();
    } else {
      audioPlayer.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      // Fallback: if loadedmetadata never fires (some streams), play after timeout
      setTimeout(() => {
        if (autoplay && audioPlayer.paused) {
          audioPlayer.play().catch(() => {});
        }
      }, 3000);
    }

    // 2. Update Visuals
    if (ytPlayer && isReady) {
      const opts = startSeconds > 0 ? { videoId, startSeconds: Math.floor(startSeconds) } : videoId;
      if (autoplay) {
        ytPlayer.loadVideoById(opts);
      } else {
        ytPlayer.cueVideoById(opts);
      }
    }
  }

  // ── Public API ──

  function loadVideo(videoId, autoplay = true, startSeconds = 0) {
    if (!videoId) return;
    
    // We don't block audio loading if ytPlayer isn't ready!
    if (!isReady) {
      currentVideoId = videoId;
      audioPlayer.src = `/api/radio/stream/${videoId}`;
      audioPlayer.load();
      
      const seekAndPlay = () => {
        if (startSeconds > 0 && isFinite(audioPlayer.duration) && audioPlayer.duration > 0) {
          try { audioPlayer.currentTime = Math.min(startSeconds, audioPlayer.duration - 1); }
          catch (e) { /* ignore */ }
        }
        if (autoplay) audioPlayer.play().catch(() => {});
      };
      
      if (audioPlayer.readyState >= 1 && isFinite(audioPlayer.duration)) {
        seekAndPlay();
      } else {
        audioPlayer.addEventListener('loadedmetadata', seekAndPlay, { once: true });
        setTimeout(() => { if (autoplay && audioPlayer.paused) audioPlayer.play().catch(() => {}); }, 3000);
      }
      
      pendingVideoId = videoId;
      pendingPlay = autoplay;
      pendingStart = startSeconds;
      return;
    }

    _doLoad(videoId, autoplay, startSeconds);
  }

  function play() {
    audioPlayer.play().catch(()=>{});
    if (isReady && ytPlayer) ytPlayer.playVideo();
  }

  function pause() {
    audioPlayer.pause();
    if (isReady && ytPlayer) ytPlayer.pauseVideo();
  }

  function setVolume(vol) {
    audioPlayer.volume = Math.max(0, Math.min(100, vol)) / 100;
  }

  function setMuted(muted) {
    audioPlayer.muted = muted;
  }

  function isPlaying() {
    return !audioPlayer.paused && audioPlayer.currentTime > 0;
  }

  function getDuration() {
    const d = audioPlayer.duration;
    if (d && !isNaN(d) && isFinite(d)) return d;
    if (isReady && ytPlayer) {
        try { return ytPlayer.getDuration() || 0; } catch { return 0; }
    }
    return 0;
  }

  function onEnded(cb) { _onEndedCb = cb; }
  function onPlaying(cb) { _onPlayingCb = cb; }
  function onError(cb) { _onErrorCb = cb; }

  return { loadVideo, play, pause, setVolume, setMuted, isPlaying, getDuration, onEnded, onPlaying, onError };
})();

// Inject YouTube IFrame API script
(function () {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.async = true;
  const first = document.getElementsByTagName('script')[0];
  first.parentNode.insertBefore(tag, first);
})();
