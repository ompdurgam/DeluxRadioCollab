"""
Seed Bollywood songs into the Delux Radio catalog from songs_links.csv.
Run: python seed_songs.py [--reseed]
"""
import sys
import os
import csv
import re
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from database import SessionLocal, create_tables, Song, AdminUser
import bcrypt


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password[:72].encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def extract_youtube_video_id(url: str) -> str:
    if not url:
        return ""
    url = url.strip()
    m = re.search(r'(?:v=|\/|be\/)([0-9A-Za-z_-]{11})', url)
    if m:
        return m.group(1)
    return ""


def parse_song_entry(raw_song: str, raw_url: str) -> dict:
    raw_song = raw_song.strip()
    raw_url = raw_url.strip()

    video_id = extract_youtube_video_id(raw_url)
    if not video_id:
        return None

    # Extract movie/album in trailing parentheses e.g. "Song - Artist (Movie)"
    movie = ""
    m_match = re.search(r'\((.*?)\)\s*$', raw_song)
    if m_match:
        movie = m_match.group(1).strip()
        raw_song = raw_song[:m_match.start()].strip()

    # Split Title and Artist by dash (en-dash \u2013, em-dash \u2014, or hyphen -)
    parts = re.split(r'\s*[\u2013\u2014-]\s*', raw_song, maxsplit=1)
    if len(parts) == 2:
        title = parts[0].strip()
        artist = parts[1].strip()
    else:
        title = raw_song.strip()
        artist = "Bollywood"

    # Determine release year if year is found in movie or context
    release_year = 1995
    year_match = re.search(r'\b(19\d\d|20\d\d)\b', movie)
    if year_match:
        release_year = int(year_match.group(1))
    elif "80s" in movie.lower() or "80s" in raw_song.lower():
        release_year = 1985
    elif "90s" in movie.lower() or "90s" in raw_song.lower():
        release_year = 1995
    elif "70s" in movie.lower() or "70s" in raw_song.lower():
        release_year = 1975
    elif "2000s" in movie.lower():
        release_year = 2005

    return {
        "title": title,
        "artist": artist,
        "movie": movie,
        "release_year": release_year,
        "language": "Hindi",
        "youtube_video_id": video_id,
        "duration": 250 + (sum(ord(c) for c in (title + video_id)) % 95),  # Realistic Bollywood duration (4:10 - 5:45)
        "active": True,
    }


def find_csv_path() -> Path:
    candidates = [
        Path(__file__).resolve().parent.parent / "songs_links.csv",
        Path(__file__).resolve().parent / "songs_links.csv",
        Path.cwd() / "songs_links.csv",
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


def load_songs_from_csv(csv_path: Path):
    songs = []
    seen_ids = set()
    with open(csv_path, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        try:
            next(reader)  # Skip header
        except StopIteration:
            return songs

        for row in reader:
            if not row or not row[0].strip():
                continue
            raw_song = row[0]
            raw_url = row[1] if len(row) > 1 else ""
            parsed = parse_song_entry(raw_song, raw_url)
            if parsed and parsed["youtube_video_id"] not in seen_ids:
                seen_ids.add(parsed["youtube_video_id"])
                songs.append(parsed)
    return songs


FALLBACK_SONGS_90S = [
    {
        "title": "Dil Hai Ke Manta Nahin",
        "artist": "Kumar Sanu, Alka Yagnik",
        "movie": "Dil Hai Ke Manta Nahin",
        "release_year": 1991,
        "language": "Hindi",
        "youtube_video_id": "BNGbA0yB01o",
    },
    {
        "title": "Pehla Nasha",
        "artist": "Udit Narayan, Sadhana Sargam",
        "movie": "Jo Jeeta Wohi Sikander",
        "release_year": 1992,
        "language": "Hindi",
        "youtube_video_id": "nmF0vCwVBEs",
    },
    {
        "title": "Saat Samundar Paar",
        "artist": "Kavita Krishnamurthy, Vipin Sachdeva",
        "movie": "Vishwatma",
        "release_year": 1992,
        "language": "Hindi",
        "youtube_video_id": "5hLSCBR8-qY",
    },
    {
        "title": "Aisi Deewangi",
        "artist": "Kavita Krishnamurthy",
        "movie": "Deewana",
        "release_year": 1992,
        "language": "Hindi",
        "youtube_video_id": "4wdL9mRAnYY",
    },
    {
        "title": "Chaiyya Chaiyya",
        "artist": "Sukhwinder Singh, Sapna Awasthi",
        "movie": "Dil Se",
        "release_year": 1998,
        "language": "Hindi",
        "youtube_video_id": "YOYN9qNXmAw",
    },
]


def seed(reseed: bool = False):
    create_tables()
    db = SessionLocal()
    try:
        csv_file = find_csv_path()
        if csv_file:
            print(f"[*] Loading songs from CSV: {csv_file}")
            songs_data = load_songs_from_csv(csv_file)
            print(f"[*] Parsed {len(songs_data)} unique songs from CSV.")
        else:
            print("[!] songs_links.csv not found; falling back to default songs list.")
            songs_data = FALLBACK_SONGS_90S

        if reseed:
            print("[*] Reseed flag specified: clearing existing songs...")
            db.query(Song).delete()
            db.commit()

        # Check existing songs in catalog to prevent duplicate insertions
        existing_vids = {s[0] for s in db.query(Song.youtube_video_id).all()}

        added_count = 0
        for s in songs_data:
            if s["youtube_video_id"] not in existing_vids:
                db.add(Song(**s))
                existing_vids.add(s["youtube_video_id"])
                added_count += 1

        if added_count > 0:
            db.commit()
            total_songs = db.query(Song).count()
            print(f"[OK] Seeded {added_count} new songs into the catalog (Total: {total_songs}).")
        else:
            total_songs = db.query(Song).count()
            print(f"[INFO] All songs already in catalog (Total: {total_songs}). Skipping duplicate insert.")

        # Create default admin if not exists
        admin_exists = db.query(AdminUser).filter(AdminUser.username == "superadmin").first()
        if not admin_exists:
            hashed = hash_password("superadmin2026")
            db.add(AdminUser(username="superadmin", password_hash=hashed))
            db.commit()
            print("[OK] Default admin created  ->  username: superadmin  |  password: superadmin2026")
        else:
            print("[INFO] Admin user already exists.")

    finally:
        db.close()


if __name__ == "__main__":
    reseed_flag = "--reseed" in sys.argv or "--reset" in sys.argv or "-r" in sys.argv
    seed(reseed=reseed_flag)
