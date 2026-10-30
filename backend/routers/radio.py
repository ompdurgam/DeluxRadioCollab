"""
Radio Router — /api/radio/*
Handles radio state, song transitions, and now-playing info.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from datetime import datetime
from fastapi.responses import RedirectResponse
import asyncio
import yt_dlp
from cachetools import TTLCache

stream_cache = TTLCache(maxsize=200, ttl=3600 * 6)

from database import get_db, Song, SessionLocal, RadioState as RadioStateModel
from services.radio_service import radio_engine

router = APIRouter(tags=["radio"])


@router.get("/state")
async def get_state(db: Session = Depends(get_db)):
    """Get current radio state — called on page load."""
    state = radio_engine.to_dict()
    return {"success": True, "state": state}

@router.get("/stream/{video_id}")
async def stream_audio(video_id: str):
    """Bypasses YouTube iframe mobile blocks by extracting raw audio stream."""
    if video_id in stream_cache:
        return RedirectResponse(stream_cache[video_id])

    import shutil

    def extract():
        # Find Node.js path for yt-dlp JS runtime (needed for YouTube signature solving)
        node_path = shutil.which("node")

        # Try multiple format strategies
        format_attempts = [
            'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
            'bestaudio/best',
            'worst',  # last resort: just get anything that works
        ]

        for fmt in format_attempts:
            ydl_opts = {
                'format': fmt,
                'quiet': True,
                'no_warnings': True,
                'skip_download': True,
                'nocheckcertificate': True,
                'socket_timeout': 15,
            }
            # yt-dlp 2026+ requires js_runtimes as dict
            if node_path:
                ydl_opts['js_runtimes'] = {'nodejs': {'path': node_path}}

            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
                    url = info.get('url')
                    dur = info.get('duration')
                    if url:
                        return url, dur, False  # url, duration, is_unavailable
            except yt_dlp.utils.DownloadError as e:
                err_str = str(e).lower()
                if any(kw in err_str for kw in ['unavailable', 'removed', 'copyright', 'private', 'blocked']):
                    print(f"[STREAM] Video {video_id} unavailable: {str(e)[:120]}")
                    return None, None, True  # Permanently gone
                print(f"[STREAM] yt-dlp format '{fmt}' failed: {str(e)[:80]}, trying next...")
            except Exception as e:
                print(f"[STREAM] yt-dlp error: {e}")

        return None, None, False

    res = await asyncio.to_thread(extract)
    url, dur, is_unavailable = res if res else (None, None, False)

    if url:
        stream_cache[video_id] = url
        if dur and dur > 10:
            asyncio.create_task(radio_engine.update_song_duration(video_id, float(dur)))
        return RedirectResponse(url)

    # Mark permanently unavailable videos as inactive so they never play again
    if is_unavailable:
        def _deactivate():
            db = SessionLocal()
            try:
                song = db.query(Song).filter(Song.youtube_video_id == video_id).first()
                if song:
                    song.active = False
                    db.commit()
                    print(f"[STREAM] Deactivated unavailable song: {song.title} ({video_id})")
            finally:
                db.close()
        await asyncio.to_thread(_deactivate)

    raise HTTPException(status_code=500, detail="Could not extract stream")


class DurationReport(BaseModel):
    video_id: str
    duration: float


@router.post("/duration")
async def report_duration(report: DurationReport):
    """Allow client to report verified duration via REST fallback."""
    if report.video_id and report.duration > 10:
        await radio_engine.update_song_duration(report.video_id, report.duration)
        return {"success": True}
    return {"success": False}


@router.post("/song-ended")
async def song_ended(db: Session = Depends(get_db)):
    """
    Client reports current song ended locally.
    If the server song has finished (elapsed >= song_duration - 5s) or server is idle,
    advance immediately and broadcast to all listeners.
    Otherwise return current song state so client can resync.
    """
    import time
    from ws.manager import manager

    elapsed = time.time() - radio_engine.song_started_at if radio_engine.song_started_at else 0
    min_threshold = max(10.0, radio_engine.song_duration - 5.0)

    if elapsed >= min_threshold or not radio_engine.is_playing:
        next_play = await radio_engine._advance()
        await radio_engine.broadcast_state()
        await manager.broadcast({"type": "play_next", "data": next_play})
        return {"success": True, "advanced": True, "next": next_play}

    return {
        "success": True,
        "advanced": False,
        "next": {
            "type": radio_engine.mode,
            "song": radio_engine.current_song,
            "started_at": radio_engine.song_started_at,
        }
    }


@router.get("/next")
async def get_next(db: Session = Depends(get_db)):
    """Get what comes next (for admin preview)."""
    if radio_engine.request_queue:
        q = radio_engine.request_queue[0]
        return {"success": True, "type": "request", "data": q}
    song = radio_engine._pick_random_song(db)
    return {"success": True, "type": "auto", "song": song}


@router.get("/queue")
async def get_queue():
    """Public queue view — shows upcoming requests."""
    return {
        "success": True,
        "queue": radio_engine.request_queue,
        "pending": radio_engine.pending_queue,
    }
