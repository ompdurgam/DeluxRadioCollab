"""
Fetch and update real YouTube video durations for all songs in delux_radio.db.
Uses fast concurrent HTTP requests with regex extraction from YouTube watch HTML.
"""
import sys
import os
import re
import asyncio
import httpx
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from database import SessionLocal, Song

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}

async def fetch_duration(client: httpx.AsyncClient, semaphore: asyncio.Semaphore, song_id: int, video_id: str):
    async with semaphore:
        try:
            url = f"https://www.youtube.com/watch?v={video_id}"
            resp = await client.get(url, follow_redirects=True)
            if resp.status_code == 200:
                text = resp.text
                m = re.search(r'"approxDurationMs":"(\d+)"', text)
                if m:
                    sec = int(m.group(1)) // 1000
                    if sec > 10:
                        return song_id, sec
                m2 = re.search(r'"lengthSeconds":"(\d+)"', text)
                if m2:
                    sec = int(m2.group(1))
                    if sec > 10:
                        return song_id, sec
        except Exception as e:
            pass
        return song_id, None


async def update_all_durations(limit: int = None):
    db = SessionLocal()
    try:
        query = db.query(Song).filter(Song.active == True)
        if limit:
            songs = query.limit(limit).all()
        else:
            songs = query.all()
        
        total = len(songs)
        print(f"[FETCH] Starting duration update for {total} songs...")

        semaphore = asyncio.Semaphore(12)
        limits = httpx.Limits(max_keepalive_connections=12, max_connections=20)

        async with httpx.AsyncClient(headers=HEADERS, limits=limits, timeout=10.0) as client:
            tasks = [fetch_duration(client, semaphore, s.id, s.youtube_video_id) for s in songs]
            
            completed = 0
            updated = 0
            id_to_song = {s.id: s for s in songs}

            for coro in asyncio.as_completed(tasks):
                song_id, sec = await coro
                completed += 1
                if sec and sec > 10:
                    s = id_to_song.get(song_id)
                    if s:
                        s.duration = sec
                        updated += 1
                if completed % 50 == 0 or completed == total:
                    db.commit()
                    print(f"[PROGRESS] {completed}/{total} processed, {updated} updated with real duration.")

            db.commit()
            print(f"[DONE] Finished updating durations: {updated}/{total} updated.")
    finally:
        db.close()

if __name__ == "__main__":
    limit_arg = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else None
    asyncio.run(update_all_durations(limit_arg))
