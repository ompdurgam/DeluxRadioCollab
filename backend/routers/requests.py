"""
Requests Router — /api/requests/*
Handles song request submission, moderation, and catalog lookup.
"""
import re
import asyncio
import httpx
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

from database import get_db, Song, Request
from services.moderation import moderate_request
from services.radio_service import radio_engine, process_request_pipeline
from ws.manager import manager

router = APIRouter(tags=["requests"])


class SongRequestBody(BaseModel):
    song_name: str = Field(..., min_length=1, max_length=200)
    requester_name: str = Field(..., min_length=1, max_length=100)
    dedicated_to: Optional[str] = Field(None, max_length=100)
    story: Optional[str] = Field(None, max_length=1000)


def find_song_in_catalog(db: Session, song_name: str) -> Optional[Song]:
    """Fuzzy search the 90s catalog for the requested song."""
    name_lower = song_name.strip().lower()

    # Exact match first
    song = db.query(Song).filter(
        Song.title.ilike(f"%{name_lower}%"),
        Song.active == True
    ).first()
    if song:
        return song

    # Try word-by-word match
    words = [w for w in name_lower.split() if len(w) > 2]
    for word in words:
        song = db.query(Song).filter(
            Song.title.ilike(f"%{word}%"),
            Song.active == True
        ).first()
        if song:
            return song

    return None


@router.post("/submit")
async def submit_request(
    body: SongRequestBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """Submit a song request — moderated, validated, then queued."""

    # 2. Extract YouTube Video ID OR Search Catalog
    match = re.search(r"(?:v=|\/)([0-9A-Za-z_-]{11}).*", body.song_name)
    if match:
        video_id = match.group(1)
        song = db.query(Song).filter(Song.youtube_video_id == video_id).first()
        if not song:
            # Fetch metadata from YouTube using yt-dlp to check category
            def fetch_yt_info():
                import yt_dlp
                ydl_opts = {'quiet': True, 'skip_download': True, 'extract_flat': 'in_playlist'}
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    return ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)

            try:
                info = await asyncio.to_thread(fetch_yt_info)
                if not info:
                    raise Exception("No info returned")
            except Exception as e:
                raise HTTPException(status_code=400, detail="❌ Could not fetch YouTube video info.")

            categories = info.get("categories", [])
            if "Music" not in categories and not any("music" in c.lower() for c in categories):
                # Try to guess from title or channel if category is missing/different
                title_lower = info.get("title", "").lower()
                uploader_lower = info.get("uploader", "").lower()
                music_keywords = ["song", "music", "official video", "audio", "lyric", "vevo"]
                is_music = any(kw in title_lower or kw in uploader_lower for kw in music_keywords)
                if not is_music:
                    raise HTTPException(status_code=400, detail="❌ Please provide a link to a Music video or Song.")

            # Extract upload/release year from YouTube metadata with fallback
            raw_year = info.get("release_year")
            if not raw_year and info.get("upload_date"):
                try:
                    raw_year = int(str(info["upload_date"])[:4])
                except (ValueError, TypeError):
                    raw_year = None
            if not raw_year:
                raw_year = datetime.utcnow().year

            song = Song(
                title=info.get("title", "Unknown Title"),
                artist=info.get("uploader", "Unknown Artist"),
                youtube_video_id=video_id,
                release_year=int(raw_year),
                duration=info.get("duration", 240),
                active=True
            )
            db.add(song)
            db.commit()
            db.refresh(song)
    else:
        # Fallback: Text search against the existing catalog
        song = find_song_in_catalog(db, body.song_name)
        if not song:
            raise HTTPException(
                status_code=404,
                detail=f"❌ '{body.song_name}' is not in the Delux catalog. Please provide a YouTube link instead."
            )

    # Prevent duplicate requests for songs currently playing or already queued
    if radio_engine.current_song and radio_engine.current_song.get("id") == song.id:
        raise HTTPException(status_code=400, detail=f"❌ '{song.title}' is currently playing on Delux Radio!")

    already_in_request_queue = any(
        req_item.get("song", {}).get("id") == song.id
        for req_item in radio_engine.request_queue
    )
    already_pending = False
    if radio_engine.pending_queue:
        pending_records = db.query(Request.song_id).filter(Request.id.in_(radio_engine.pending_queue)).all()
        already_pending = any(r[0] == song.id for r in pending_records)

    if already_in_request_queue or already_pending:
        raise HTTPException(
            status_code=400,
            detail=f"❌ '{song.title}' is already in the request queue! Please request another track."
        )

    # 3. Content moderation
    safe, reason = await moderate_request(
        song_name=song.title,
        requester_name=body.requester_name,
        dedicated_to=body.dedicated_to,
        story=body.story,
    )
    if not safe:
        raise HTTPException(status_code=400, detail=f"❌ Request rejected: {reason}")

    # 4. Create request record — immediately mark as queued
    req = Request(
        song_id=song.id,
        song_name_raw=body.song_name,
        requester_name=body.requester_name,
        dedicated_to=body.dedicated_to,
        story=body.story,
        status="queued",          # queued immediately
        moderation_status="approved",
        created_at=datetime.utcnow(),
    )
    db.add(req)
    db.commit()
    db.refresh(req)

    # 5. Build song dict for the queue
    song_dict = {
        "id":               song.id,
        "title":            song.title,
        "artist":           song.artist,
        "movie":            song.movie or "",
        "release_year":     song.release_year,
        "youtube_video_id": song.youtube_video_id,
    }

    # 6. Mark as pending. The AI pipeline will add it to the ready queue once done.
    queue_position = len(radio_engine.request_queue) + len(radio_engine.pending_queue) + 1
    if req.id not in radio_engine.pending_queue:
        radio_engine.pending_queue.append(req.id)

    # 7. AI pipeline runs in background — enriches queue entry with RJ script + audio
    background_tasks.add_task(process_request_pipeline, req.id)

    # 8. Broadcast state so all clients see the updated queue
    await radio_engine.broadcast_state()

    # 9. Notify listeners
    await manager.broadcast_notification(
        title="🎙️ New Request!",
        body=f"{body.requester_name} requested '{song.title}' — #{queue_position} in queue",
        notif_type="request_incoming"
    )

    return {
        "success": True,
        "message": f"✅ Your request for '{song.title}' has been added to the queue at position #{queue_position}!",
        "request_id": req.id,
        "queue_position": queue_position,
        "song": {
            "title": song.title,
            "artist": song.artist,
            "movie": song.movie,
            "release_year": song.release_year,
        },
    }


@router.get("/search")
async def search_catalog(q: str, db: Session = Depends(get_db)):
    """Search the existing catalog for autocomplete suggestions."""
    if not q or len(q.strip()) < 2:
        return {"success": True, "results": []}
    
    query = q.strip().lower()
    songs = db.query(Song).filter(
        Song.title.ilike(f"%{query}%"),
        Song.active == True
    ).limit(5).all()
    
    return {
        "success": True,
        "results": [
            {"id": s.id, "title": s.title, "artist": s.artist}
            for s in songs
        ]
    }


@router.get("/recent")
async def get_recent_requests(db: Session = Depends(get_db)):
    """Get recently completed requests (for display)."""
    recent = db.query(Request).filter(
        Request.status == "completed"
    ).order_by(Request.processed_at.desc()).limit(10).all()

    return {
        "success": True,
        "requests": [
            {
                "id": r.id,
                "song_title": r.song.title if r.song else r.song_name_raw,
                "requester_name": r.requester_name,
                "dedicated_to": r.dedicated_to,
                "processed_at": r.processed_at.isoformat() if r.processed_at else None,
            }
            for r in recent
        ]
    }
