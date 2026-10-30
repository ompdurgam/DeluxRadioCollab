"""
Admin Router — Delux Radio
Password-protected endpoints for the admin dashboard.
"""
import os
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

from services.radio_service import radio_engine
from database import Song, SessionLocal, AdminUser
import bcrypt
import httpx

router = APIRouter(tags=["admin"])


def _require_auth(x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    if not x_admin_username or not x_admin_password:
        raise HTTPException(status_code=401, detail="Missing admin credentials")
    db = SessionLocal()
    try:
        user = db.query(AdminUser).filter(AdminUser.username == x_admin_username).first()
        if not user or not bcrypt.checkpw(x_admin_password.encode('utf-8'), user.password_hash.encode('utf-8')):
            raise HTTPException(status_code=401, detail="Invalid admin credentials")
    finally:
        db.close()


class AuthBody(BaseModel):
    username: str
    password: str

# ── Auth ───────────────────────────────────────────────────────────────────────
@router.post("/auth")
def auth_check(body: AuthBody):
    username = body.username
    password = body.password
    if not username or not password:
        raise HTTPException(status_code=401, detail="Missing credentials")
    
    db = SessionLocal()
    try:
        user = db.query(AdminUser).filter(AdminUser.username == username).first()
        if not user or not bcrypt.checkpw(password.encode('utf-8'), user.password_hash.encode('utf-8')):
            raise HTTPException(status_code=401, detail="Wrong credentials")
    finally:
        db.close()
    return {"success": True}


# ── Status ─────────────────────────────────────────────────────────────────────
@router.get("/status")
def get_status(x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    return {"success": True, "data": radio_engine.to_dict()}


class ToggleRJBody(BaseModel):
    enabled: bool

@router.post("/toggle-rj")
async def toggle_rj(body: ToggleRJBody, x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    radio_engine.rj_enabled = body.enabled
    await radio_engine.broadcast_state()
    return {"success": True, "rj_enabled": radio_engine.rj_enabled}


# ── Upcoming queue ─────────────────────────────────────────────────────────────
@router.get("/upcoming")
def get_upcoming(x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    return {
        "success":  True,
        "upcoming": radio_engine.upcoming_queue,
        "current":  radio_engine.current_song,
    }


class ReorderBody(BaseModel):
    song_ids: List[int]


@router.put("/upcoming/reorder")
async def reorder_upcoming(body: ReorderBody, x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    radio_engine.admin_reorder_upcoming(body.song_ids)
    await radio_engine.broadcast_state()
    return {"success": True, "upcoming": radio_engine.upcoming_queue}


class AddSongBody(BaseModel):
    song_id: int
    position: int = 0


@router.post("/upcoming/add")
async def add_to_upcoming(body: AddSongBody, x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    ok = await radio_engine.admin_add_to_upcoming(body.song_id, body.position)
    if not ok:
        raise HTTPException(status_code=404, detail="Song not found")
    await radio_engine.broadcast_state()
    return {"success": True, "upcoming": radio_engine.upcoming_queue}


@router.delete("/upcoming/{song_id}")
async def remove_from_upcoming(song_id: int, x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    ok = radio_engine.admin_remove_from_upcoming(song_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Song not in upcoming queue")
    await radio_engine.broadcast_state()
    return {"success": True, "upcoming": radio_engine.upcoming_queue}


# ── Skip ───────────────────────────────────────────────────────────────────────
@router.post("/skip")
async def skip_song(x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    next_play = await radio_engine.admin_skip()
    return {"success": True, "next": next_play}


# ── Catalog ────────────────────────────────────────────────────────────────────
@router.get("/songs")
def get_all_songs(x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    db = SessionLocal()
    try:
        songs = db.query(Song).filter(Song.active == True).order_by(Song.title).all()
        return {
            "success": True,
            "songs": [
                {
                    "id": s.id, "title": s.title, "artist": s.artist,
                    "movie": s.movie or "", "release_year": s.release_year,
                    "youtube_video_id": s.youtube_video_id,
                    "duration": s.duration,
                }
                for s in songs
            ],
        }
    finally:
        db.close()

class NewSongBody(BaseModel):
    title: str
    artist: str
    movie: Optional[str] = ""
    release_year: int
    youtube_video_id: str
    duration: Optional[int] = None

@router.post("/songs")
def add_new_song(body: NewSongBody, x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    dur = body.duration
    if not dur or dur < 10:
        # Fast fallback: attempt regex check
        try:
            import httpx, re
            r = httpx.get(f"https://www.youtube.com/watch?v={body.youtube_video_id}", timeout=4.0, follow_redirects=True)
            m = re.search(r'"approxDurationMs":"(\d+)"', r.text) or re.search(r'"lengthSeconds":"(\d+)"', r.text)
            if m:
                dur = int(m.group(1)) // 1000 if 'approx' in m.group(0) else int(m.group(1))
        except Exception:
            pass
    if not dur or dur < 10:
        dur = 250

    db = SessionLocal()
    try:
        new_song = Song(
            title=body.title,
            artist=body.artist,
            movie=body.movie,
            release_year=body.release_year,
            youtube_video_id=body.youtube_video_id,
            duration=dur,
            active=True
        )
        db.add(new_song)
        db.commit()
        db.refresh(new_song)
        return {"success": True, "song_id": new_song.id, "duration": new_song.duration}
    finally:
        db.close()


@router.delete("/songs/{song_id}")
async def delete_song(song_id: int, x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    db = SessionLocal()
    try:
        song = db.query(Song).filter(Song.id == song_id).first()
        if not song:
            raise HTTPException(status_code=404, detail="Song not found")
        song.active = False
        db.commit()
    finally:
        db.close()

    # If song was in upcoming queue, remove it and refill
    radio_engine.admin_remove_from_upcoming(song_id)
    # If in request queue, remove as well
    radio_engine.request_queue = [r for r in radio_engine.request_queue if r.get("song", {}).get("id") != song_id]
    await radio_engine.broadcast_state()

    return {"success": True, "message": f"Song {song_id} deleted"}


@router.delete("/requests/{request_id}")
async def delete_request(request_id: int, x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    before = len(radio_engine.request_queue)
    radio_engine.request_queue = [r for r in radio_engine.request_queue if r.get("request_id") != request_id]
    if len(radio_engine.request_queue) < before:
        await radio_engine.broadcast_state()
        return {"success": True, "message": f"Request {request_id} removed"}
    raise HTTPException(status_code=404, detail="Request not found in queue")


@router.get("/yt-info")
async def get_yt_info(url: str, x_admin_username: str = Header(None), x_admin_password: str = Header(None)):
    _require_auth(x_admin_username, x_admin_password)
    import re
    m = re.search(r'(?:v=|\/|be\/)([0-9A-Za-z_-]{11})', url)
    video_id = m.group(1) if m else None

    title = None
    author = None
    duration = None

    if video_id:
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                resp = await client.get(f"https://www.youtube.com/watch?v={video_id}", follow_redirects=True)
                if resp.status_code == 200:
                    text = resp.text
                    dm = re.search(r'"approxDurationMs":"(\d+)"', text) or re.search(r'"lengthSeconds":"(\d+)"', text)
                    if dm:
                        duration = int(dm.group(1)) // 1000 if 'approx' in dm.group(0) else int(dm.group(1))
                    tm = re.search(r'<title>(.*?)</title>', text)
                    if tm:
                        t = tm.group(1).replace(" - YouTube", "").strip()
                        if t:
                            title = t
        except Exception:
            pass

    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            resp = await client.get(f"https://www.youtube.com/oembed?url={url}&format=json")
            if resp.status_code == 200:
                data = resp.json()
                title = title or data.get("title")
                author = data.get("author_name")
        except Exception:
            pass

    if title or video_id:
        return {
            "success": True,
            "title": title or "Unknown Title",
            "author": author or "Unknown Artist",
            "video_id": video_id,
            "duration": duration,
        }
    raise HTTPException(status_code=400, detail="Invalid YouTube URL or video unavailable")
