"""
Seed 90s Bollywood songs into the Delux Radio catalog.
Run once: python seed_songs.py
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from database import SessionLocal, create_tables, Song, AdminUser
import bcrypt

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password[:72].encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

SONGS_90S = [
    # ─── 1990–1993 ────────────────────────────────────────────────────────────
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
        "title": "Muqabala Muqabala",
        "artist": "S.P. Balasubrahmanyam",
        "movie": "Gentleman",
        "release_year": 1993,
        "language": "Hindi/Tamil",
        "youtube_video_id": "qCGCLQXy4k0",
    },
    # ─── 1994 ─────────────────────────────────────────────────────────────────
    {
        "title": "Tu Cheez Badi Hai Mast Mast",
        "artist": "Udit Narayan, Kavita Krishnamurthy",
        "movie": "Mohra",
        "release_year": 1994,
        "language": "Hindi",
        "youtube_video_id": "aZJTKp_7j_0",
    },
    {
        "title": "Ek Ladki Ko Dekha",
        "artist": "Kumar Sanu",
        "movie": "1942: A Love Story",
        "release_year": 1994,
        "language": "Hindi",
        "youtube_video_id": "1YKBkS6N_7s",
    },
    {
        "title": "Ole Ole",
        "artist": "Udit Narayan",
        "movie": "Yeh Dillagi",
        "release_year": 1994,
        "language": "Hindi",
        "youtube_video_id": "3mHHHPz_VIE",
    },
    {
        "title": "Chura Ke Dil Mera",
        "artist": "Abhijeet Bhattacharya, Udit Narayan",
        "movie": "Main Khiladi Tu Anari",
        "release_year": 1994,
        "language": "Hindi",
        "youtube_video_id": "hFv7kKfzmGk",
    },
    {
        "title": "Humma Humma",
        "artist": "A.R. Rahman, Udit Narayan",
        "movie": "Bombay",
        "release_year": 1995,
        "language": "Tamil/Hindi",
        "youtube_video_id": "iHqH5GaVnwQ",
    },
    # ─── 1995 ─────────────────────────────────────────────────────────────────
    {
        "title": "Tujhe Dekha Toh",
        "artist": "Kumar Sanu, Lata Mangeshkar",
        "movie": "Dilwale Dulhania Le Jayenge",
        "release_year": 1995,
        "language": "Hindi",
        "youtube_video_id": "eKBp5dRVEwA",
    },
    {
        "title": "Mehndi Laga Ke Rakhna",
        "artist": "Udit Narayan, Kavita Krishnamurthy",
        "movie": "Dilwale Dulhania Le Jayenge",
        "release_year": 1995,
        "language": "Hindi",
        "youtube_video_id": "KWNNJOBzZaU",
    },
    {
        "title": "Mere Sapno Ki Rani",
        "artist": "Kishore Kumar",
        "movie": "Aradhana",
        "release_year": 1990,
        "language": "Hindi",
        "youtube_video_id": "wMlNsqtOQl4",
    },
    # ─── 1996–1997 ────────────────────────────────────────────────────────────
    {
        "title": "Maahi Ve",
        "artist": "Udit Narayan, Kavita Krishnamurthy",
        "movie": "Kaante",
        "release_year": 1997,
        "language": "Hindi",
        "youtube_video_id": "Yv1FMbCxb6g",
    },
    {
        "title": "Ye Dil Deewana",
        "artist": "Kumar Sanu",
        "movie": "Pardes",
        "release_year": 1997,
        "language": "Hindi",
        "youtube_video_id": "kEHDqkjXusc",
    },
    {
        "title": "Do Dil Mil Rahe Hain",
        "artist": "Kumar Sanu, Alka Yagnik",
        "movie": "Pardes",
        "release_year": 1997,
        "language": "Hindi",
        "youtube_video_id": "4q85dBxreMc",
    },
    {
        "title": "Sandese Aate Hain",
        "artist": "Sonu Nigam, Hariharan",
        "movie": "Border",
        "release_year": 1997,
        "language": "Hindi",
        "youtube_video_id": "5wRWnOKSLJw",
    },
    # ─── 1998 ─────────────────────────────────────────────────────────────────
    {
        "title": "Kuch Kuch Hota Hai",
        "artist": "Udit Narayan, Alka Yagnik",
        "movie": "Kuch Kuch Hota Hai",
        "release_year": 1998,
        "language": "Hindi",
        "youtube_video_id": "gq5OZ8dXFsA",
    },
    {
        "title": "Tujhe Yaad Na Meri Aayee",
        "artist": "Udit Narayan, Kavita Krishnamurthy",
        "movie": "Kuch Kuch Hota Hai",
        "release_year": 1998,
        "language": "Hindi",
        "youtube_video_id": "3HOxph0XKGI",
    },
    {
        "title": "Chaiyya Chaiyya",
        "artist": "Sukhwinder Singh, Sapna Awasthi",
        "movie": "Dil Se",
        "release_year": 1998,
        "language": "Hindi",
        "youtube_video_id": "sDvpXnNOFMM",
    },
    {
        "title": "Dil Se Re",
        "artist": "A.R. Rahman",
        "movie": "Dil Se",
        "release_year": 1998,
        "language": "Hindi",
        "youtube_video_id": "2t2SZLXfCGI",
    },
    {
        "title": "Mere Humsafar",
        "artist": "Udit Narayan, Alka Yagnik",
        "movie": "Kuch Kuch Hota Hai",
        "release_year": 1998,
        "language": "Hindi",
        "youtube_video_id": "6DPXp9u7B0k",
    },
    # ─── 1999 ─────────────────────────────────────────────────────────────────
    {
        "title": "Yeh Dil To Pagal Hai",
        "artist": "Lata Mangeshkar, Udit Narayan",
        "movie": "Dil To Pagal Hai",
        "release_year": 1997,
        "language": "Hindi",
        "youtube_video_id": "jXaRwxJFgT8",
    },
    {
        "title": "Mere Yaar Ki Shaadi Hai",
        "artist": "Udit Narayan, Asha Bhosle",
        "movie": "Mere Yaar Ki Shaadi Hai",
        "release_year": 2002,
        "language": "Hindi",
        "youtube_video_id": "nGzLXJY6p7c",
    },
    {
        "title": "Pyar Ke Pal",
        "artist": "KK",
        "movie": "Pal",
        "release_year": 1999,
        "language": "Hindi",
        "youtube_video_id": "vZ1dJg8yYew",
    },
    {
        "title": "Tanha Tanha",
        "artist": "Udit Narayan, Kavita Krishnamurthy",
        "movie": "Rangeela",
        "release_year": 1995,
        "language": "Hindi",
        "youtube_video_id": "9Bw6vGXxlkE",
    },
    {
        "title": "Yeh Kaali Kaali Aankhein",
        "artist": "Kumar Sanu",
        "movie": "Baazigar",
        "release_year": 1993,
        "language": "Hindi",
        "youtube_video_id": "Mv-bpIkBoZs",
    },
    {
        "title": "Jaadu Teri Nazar",
        "artist": "Udit Narayan",
        "movie": "Darr",
        "release_year": 1993,
        "language": "Hindi",
        "youtube_video_id": "Y4hcn0b4BEI",
    },
    {
        "title": "Ek Hasina Thi",
        "artist": "Kumar Sanu",
        "movie": "Kaho Naa Pyaar Hai",
        "release_year": 2000,
        "language": "Hindi",
        "youtube_video_id": "3kG8MwPg6h0",
    },
    {
        "title": "Dola Re Dola",
        "artist": "Kavita Krishnamurthy, Shreya Ghoshal",
        "movie": "Devdas",
        "release_year": 2002,
        "language": "Hindi",
        "youtube_video_id": "3xHzv4Htj1Y",
    },
]


def seed():
    create_tables()
    db = SessionLocal()
    try:
        existing = db.query(Song).count()
        if existing > 0:
            print(f"[INFO] {existing} songs already in catalog. Skipping seed.")
        else:
            for s in SONGS_90S:
                db.add(Song(**s))
            db.commit()
            print(f"[OK] Seeded {len(SONGS_90S)} songs into the catalog.")

        # Create default admin if not exists
        from database import AdminUser
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
    seed()
