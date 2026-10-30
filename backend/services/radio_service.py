"""
Radio Service — Delux Radio
True server-controlled streaming with pre-planned upcoming queue.
"""
import asyncio
import os
import random
import time
from typing import Optional, Dict, List

from database import Song, Request, SessionLocal
from ws.manager import manager

_DEFAULT_SONG_DURATION = 240   # fallback until client reports actual duration
_UPCOMING_QUEUE_SIZE   = 5     # how many songs to pre-plan


class RadioEngine:
    def __init__(self):
        self.current_song: Optional[Dict] = None
        self.song_started_at: float = 0.0
        self.song_duration:   float = _DEFAULT_SONG_DURATION
        self._duration_confirmed: bool = False

        # Pre-planned upcoming songs (admin can reorder these)
        self.upcoming_queue: List[Dict] = []

        # Song requests processed by AI pipeline
        self.request_queue: List[Dict] = []
        self.pending_queue: List[int]  = []

        self.mode: str       = "auto"
        self.is_playing: bool = False
        self.rj_enabled: bool = os.getenv("RJ_ENABLED", "true").lower() in ("true", "1", "yes")
        self._processing_lock = asyncio.Lock()
        self._auto_loop_task: Optional[asyncio.Task] = None

    # ── State snapshot ─────────────────────────────────────────────────────────
    def to_dict(self) -> Dict:
        return {
            "current_song":    self.current_song,
            "song_started_at": self.song_started_at,
            "song_duration":   self.song_duration,
            "server_time":     time.time(),
            "upcoming_queue":  self.upcoming_queue[:_UPCOMING_QUEUE_SIZE],
            "request_queue":   self.request_queue,
            "queue":           self.request_queue,
            "pending_count":   len(self.pending_queue),
            "listener_count":  manager.listener_count,
            "mode":            self.mode,
            "is_playing":      self.is_playing,
            "rj_enabled":      self.rj_enabled,
        }

    # ── Song helpers ───────────────────────────────────────────────────────────
    def _song_to_dict(self, song: Song) -> Dict:
        dur = song.duration if (song.duration and song.duration > 20) else _DEFAULT_SONG_DURATION
        return {
            "id":               song.id,
            "title":            song.title,
            "artist":           song.artist,
            "movie":            song.movie or "",
            "release_year":     song.release_year,
            "youtube_video_id": song.youtube_video_id,
            "duration":         dur,
        }

    def _pick_random_song(self, db, exclude_ids: List[str] = None) -> Optional[Dict]:
        """Pick a random active song, avoiding recently played IDs."""
        songs = db.query(Song).filter(Song.active == True).all()
        if not songs:
            return None
        if exclude_ids and len(songs) > len(exclude_ids):
            songs = [s for s in songs if s.youtube_video_id not in exclude_ids]
        return self._song_to_dict(random.choice(songs))

    # ── Pre-fill upcoming queue ────────────────────────────────────────────────
    def _refill_upcoming(self, db):
        """Keep upcoming_queue topped up to _UPCOMING_QUEUE_SIZE."""
        used_ids = []
        if self.current_song:
            used_ids.append(self.current_song["youtube_video_id"])
        used_ids += [s["youtube_video_id"] for s in self.upcoming_queue]

        while len(self.upcoming_queue) < _UPCOMING_QUEUE_SIZE:
            song = self._pick_random_song(db, exclude_ids=used_ids)
            if not song:
                break
            self.upcoming_queue.append(song)
            used_ids.append(song["youtube_video_id"])

    # ── Startup ────────────────────────────────────────────────────────────────
    def boot_with_song(self):
        """
        Called once at server start.
        Immediately picks a song to stream AND pre-fills the upcoming queue.
        """
        db = SessionLocal()
        try:
            # Start playing
            song = self._pick_random_song(db)
            if song:
                dur = float(song.get("duration") or _DEFAULT_SONG_DURATION)
                self.current_song      = song
                self.song_started_at   = time.time()
                self.song_duration     = dur
                self._duration_confirmed = bool(dur != _DEFAULT_SONG_DURATION)
                self.is_playing        = True
                self.mode              = "auto"
                print(f"[RADIO ON AIR] {song['title']} -- {song['artist']} ({dur:.0f}s)")

            # Pre-fill upcoming queue
            self._refill_upcoming(db)
            if self.upcoming_queue:
                titles = [s["title"] for s in self.upcoming_queue]
                print(f"[QUEUE] Upcoming: {' -> '.join(titles)}")
        finally:
            db.close()

    # ── Duration reporting ─────────────────────────────────────────────────────
    async def update_song_duration(self, video_id: str, duration_seconds: float):
        if duration_seconds < 10:
            return

        duration_seconds = float(duration_seconds)

        # Save confirmed duration to DB so future plays use this exact length
        def _save_db():
            db = SessionLocal()
            try:
                db_song = db.query(Song).filter(Song.youtube_video_id == video_id).first()
                if db_song:
                    db_song.duration = int(duration_seconds)
                    db.commit()
            except Exception as e:
                print(f"[DURATION DB ERR] {e}")
            finally:
                db.close()

        await asyncio.to_thread(_save_db)

        # Update in upcoming queue if present
        for s in self.upcoming_queue:
            if s.get("youtube_video_id") == video_id:
                s["duration"] = int(duration_seconds)

        # Update current song if it matches
        if self.current_song and self.current_song.get("youtube_video_id") == video_id:
            if not self._duration_confirmed or abs(self.song_duration - duration_seconds) > 2:
                print(f"[DURATION] Confirmed: {duration_seconds:.0f}s for \"{self.current_song['title']}\"")
                self.song_duration       = duration_seconds
                self.current_song["duration"] = int(duration_seconds)
                self._duration_confirmed = True
                await self.broadcast_state()

    # ── Server auto-loop (THE authoritative clock) ─────────────────────────────
    async def start_auto_loop(self):
        """
        Runs forever. Every second, checks if current song is done.
        The server — not any client — decides when to advance.
        """
        print("[LOOP] Server auto-loop started (1-second resolution)")
        import os
        from pathlib import Path
        audio_dir = Path(__file__).parent.parent / "audio"
        loop_count = 0
        
        while True:
            await asyncio.sleep(1)
            loop_count += 1
            
            # Every 60 seconds, clean up audio files older than 10 minutes (600s)
            if loop_count % 60 == 0:
                try:
                    now = time.time()
                    for f in audio_dir.glob("rj_*"):
                        if f.is_file() and (now - f.stat().st_mtime) > 600:
                            f.unlink(missing_ok=True)
                except Exception as e:
                    print(f"[CLEANUP ERR] {e}")

            if not self.is_playing or not self.song_started_at:
                continue
            elapsed = time.time() - self.song_started_at
            if elapsed >= self.song_duration + 1:
                print(f"[SKIP] [{elapsed:.0f}s/{self.song_duration:.0f}s] Advancing...")
                next_play = await self._advance()
                await self.broadcast_state()
                await manager.broadcast({"type": "play_next", "data": next_play})

    # ── Advance to next song ───────────────────────────────────────────────────
    async def _advance(self) -> Dict:
        """Internal: pick the next song from request_queue or upcoming_queue."""
        db = SessionLocal()
        try:
            # 1) Listener requests take priority
            if self.request_queue:
                req = self.request_queue[0]
                if req.get("ready"):
                    self.request_queue.pop(0)
                    self.mode = "request"
                    song = req.get("song")
                    if song:
                        self.current_song = song
                    dur = float(song.get("duration") if (song and song.get("duration")) else _DEFAULT_SONG_DURATION)
                    self.song_started_at     = time.time()
                    self.song_duration       = dur
                    self._duration_confirmed = bool(dur != _DEFAULT_SONG_DURATION)
                    self._refill_upcoming(db)
                    return {
                        "type":         "request",
                        "request_id":   req["request_id"],
                        "rj_audio_url": req.get("rj_audio_url"),
                        "song":         song,
                        "started_at":   self.song_started_at,
                    }

            # 2) Pre-planned upcoming queue
            self.mode = "auto"
            if self.upcoming_queue:
                song = self.upcoming_queue.pop(0)
            else:
                song = self._pick_random_song(db)

            if not song:
                return {"type": "error", "message": "No songs in catalog"}

            dur = float(song.get("duration") or _DEFAULT_SONG_DURATION)
            self.current_song        = song
            self.song_started_at     = time.time()
            self.song_duration       = dur
            self._duration_confirmed = bool(dur != _DEFAULT_SONG_DURATION)

            # Top up the queue after consuming one
            self._refill_upcoming(db)

            return {"type": "auto", "song": song, "started_at": self.song_started_at}
        finally:
            db.close()

    # ── Public API used by WS handler and admin ────────────────────────────────
    async def get_next(self) -> Dict:
        """Alias used by existing code."""
        return await self._advance()

    async def admin_skip(self) -> Dict:
        """Admin: immediately skip to next song."""
        next_play = await self._advance()
        await self.broadcast_state()
        await manager.broadcast({"type": "play_next", "data": next_play})
        return next_play

    def admin_reorder_upcoming(self, song_ids: List[int]) -> bool:
        """
        Admin: reorder upcoming_queue by a new list of song IDs.
        Only songs already in the queue can be reordered.
        Returns True on success.
        """
        id_to_song = {s["id"]: s for s in self.upcoming_queue}
        new_queue = []
        for sid in song_ids:
            if sid in id_to_song:
                new_queue.append(id_to_song[sid])

        # Keep any songs not in the new order (e.g. if partial list sent)
        reordered_ids = set(song_ids)
        for s in self.upcoming_queue:
            if s["id"] not in reordered_ids:
                new_queue.append(s)

        self.upcoming_queue = new_queue[:_UPCOMING_QUEUE_SIZE]
        print(f"[QUEUE] Admin reordered: {[s['title'] for s in self.upcoming_queue]}")
        return True

    async def admin_add_to_upcoming(self, song_id: int, position: int = 0) -> bool:
        """Admin: insert a specific song into the upcoming queue (defaults to position 0: top/front of queue)."""
        db = SessionLocal()
        try:
            song = db.query(Song).filter(Song.id == song_id, Song.active == True).first()
            if not song:
                return False
            song_dict = self._song_to_dict(song)
            # Remove if already in queue
            self.upcoming_queue = [s for s in self.upcoming_queue if s["id"] != song_id]
            if position <= 0:
                self.upcoming_queue.insert(0, song_dict)
            elif position >= len(self.upcoming_queue):
                self.upcoming_queue.append(song_dict)
            else:
                self.upcoming_queue.insert(position, song_dict)
            self.upcoming_queue = self.upcoming_queue[:_UPCOMING_QUEUE_SIZE]
            print(f"[QUEUE] Admin added '{song.title}' to queue at position {min(position, len(self.upcoming_queue)-1)}")
            return True
        finally:
            db.close()

    def admin_remove_from_upcoming(self, song_id: int) -> bool:
        """Admin: remove a song from upcoming queue and add a fresh random one."""
        before = len(self.upcoming_queue)
        self.upcoming_queue = [s for s in self.upcoming_queue if s["id"] != song_id]
        if len(self.upcoming_queue) < before:
            db = SessionLocal()
            try:
                self._refill_upcoming(db)
            finally:
                db.close()
            return True
        return False

    # ── Request queue management ───────────────────────────────────────────────
    def add_to_ready_queue(
        self,
        request_id: int,
        song: Dict,
        rj_audio_url: Optional[str],
        requester_name: str,
        dedicated_to: Optional[str],
    ):
        self.request_queue.append({
            "request_id":     request_id,
            "song":           song,
            "rj_audio_url":   rj_audio_url,
            "requester_name": requester_name,
            "dedicated_to":   dedicated_to,
            "ready":          True,
        })
        if request_id in self.pending_queue:
            self.pending_queue.remove(request_id)

    # ── Broadcast ──────────────────────────────────────────────────────────────
    async def broadcast_state(self):
        await manager.broadcast_radio_state(self.to_dict())


# Singleton
radio_engine = RadioEngine()


# ── Request AI pipeline ────────────────────────────────────────────────────────
async def process_request_pipeline(request_id: int):
    """
    Background AI pipeline: generates RJ script + TTS audio for a request.
    The song is already in request_queue (ready=True) so it will play even if
    this pipeline is slow or fails. When audio is ready, the existing queue
    entry is updated in-place with the rj_audio_url.
    """
    from services.ai_service import generate_rj_script, classify_emotion
    from services.tts_service import generate_voice, get_audio_path, get_final_audio_path, get_audio_url
    from services.audio_mixer import mix_rj_announcement

    db = SessionLocal()
    try:
        req = db.query(Request).filter(Request.id == request_id).first()
        if not req:
            return
        song = req.song
        if not song:
            return

        rj_audio_url = None

        if radio_engine.rj_enabled:
            emotion = classify_emotion(req.story or "")
            req.emotion_tag = emotion

            print(f"[RJ] Generating script for request #{request_id} '{song.title}'...")
            script_data = await generate_rj_script(
                song_title=song.title, artist=song.artist,
                requester_name=req.requester_name, dedicated_to=req.dedicated_to,
                story=req.story, emotion=emotion,
            )
            
            if isinstance(script_data, dict):
                script_text = script_data.get("reply", "")
                voice_instr = script_data.get("voice_instruction", f"warm, {emotion}, conversational")
            else:
                script_text = script_data
                voice_instr = f"warm, {emotion}, conversational"
                
            req.rj_script = script_text
            db.commit()

            voice_path = get_audio_path(request_id)
            tts_ok = await generate_voice(script_text, voice_instr, voice_path)

            if tts_ok:
                final_path = get_final_audio_path(request_id)
                if await mix_rj_announcement(voice_path, final_path):
                    rj_audio_url = get_audio_url(request_id)
                    req.rj_audio_path = final_path

            db.commit()

        db.commit()

        # Update the queue by adding the request now that audio generation is finished.
        song_dict = {
            "id":               song.id,
            "title":            song.title,
            "artist":           song.artist,
            "movie":            song.movie or "",
            "release_year":     song.release_year,
            "youtube_video_id": song.youtube_video_id,
        }
        
        radio_engine.add_to_ready_queue(
            request_id=request_id,
            song=song_dict,
            rj_audio_url=rj_audio_url,
            requester_name=req.requester_name,
            dedicated_to=req.dedicated_to,
        )

        await radio_engine.broadcast_state()
        print(f"[OK] Pipeline done for #{request_id} (rj_audio={'yes' if rj_audio_url else 'no'})")

    except Exception as e:
        print(f"[ERR] Pipeline error for request #{request_id}: {e}")
    finally:
        db.close()
