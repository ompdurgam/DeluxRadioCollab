"""
AI Service — Delux Radio
Uses Ollama + Llama 3 to generate cinematic female RJ scripts.
Falls back to warm template scripts if Ollama is unavailable.
"""
import httpx
import json
import random
import os
from typing import Optional

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "qwen3:8b"

EMOTION_TAGS = {
    "romantic": ["❤️", "love", "sweetheart", "darling", "pyaar"],
    "nostalgic": ["school", "college", "childhood", "yaad", "purani"],
    "emotional": ["dil", "heart", "cry", "aansu", "miss"],
    "heartbreak": ["breakup", "separated", "gone", "lost", "left"],
    "friendship": ["friend", "yaar", "dost", "buddy", "together"],
    "family": ["mom", "maa", "dad", "papa", "sister", "bhai", "family"],
}


def classify_emotion(story: str) -> str:
    if not story:
        return "nostalgic"
    story_lower = story.lower()
    for emotion, keywords in EMOTION_TAGS.items():
        for kw in keywords:
            if kw in story_lower:
                return emotion
    return "nostalgic"


async def check_ollama_available() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
            return resp.status_code == 200
    except Exception:
        return False


async def generate_rj_script(
    song_title: str,
    artist: str,
    requester_name: str,
    dedicated_to: Optional[str] = None,
    story: Optional[str] = None,
    emotion: str = "nostalgic"
) -> str:
    """
    Generate a warm cinematic RJ announcement script.
    Tries Ollama/Llama3 first, falls back to templates.
    """
    dedication_line = f"dedicated to {dedicated_to}" if dedicated_to else ""
    story_line = f"Their story: {story}" if story else ""

    prompt = f"""You are Priya, a warm and charismatic late-night radio jockey on 'Delux Radio' — a station famous for 90s Bollywood hits. Your voice is deeply emotional and has a touch of classic Bollywood 'masala', but you keep the drama balanced and grounded. You speak to your listeners as if they are your closest confidants.

Here are the details for the next segment:
- Requester: {requester_name}
- Dedication: {dedication_line}
- The story/message: {story_line}
- Song: "{song_title}" by {artist}

Your task: Rephrase this request into an immersive radio announcement (under 120 words).
- Make sure it is VERY CLEAR who is making the request, who it is dedicated to, and what their message is.
- Keep the drama natural, not over-the-top. Add a subtle touch of Hindi/Urdu poetic flair if it fits.
- IMPORTANT: When mentioning the song, ONLY say the short, initial, core name of the song. Ignore all extra fluff like 'Video Song', 'Full Audio', or actor names.
- Announce the song name right at the very end of your script to build anticipation.
- Tone: Warm, clear, {emotion}, and nostalgic.

You MUST respond with a single JSON object in this exact shape and nothing else:
{{
  "reply": "<your natural spoken script here>",
  "voice_instruction": "<detailed description of tone, emotion, pacing, and pitch>"
}}
"""

    if GEMINI_API_KEY:
        try:
            gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key={GEMINI_API_KEY}"
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json"}
            }
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.post(gemini_url, json=payload)
                data = response.json()
                if "candidates" in data and data["candidates"]:
                    text_content = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                    if text_content.startswith("```json"):
                        text_content = text_content[7:-3].strip()
                    parsed = json.loads(text_content)
                    if "reply" in parsed and "voice_instruction" in parsed:
                        print(f"✅ Gemini generated RJ script successfully!")
                        return parsed
        except Exception as e:
            print(f"⚠️ Gemini API error: {e}. Falling back to Ollama or templates.")

    if await check_ollama_available():
        try:
            async with httpx.AsyncClient(timeout=45) as client:
                response = await client.post(
                    f"{OLLAMA_URL}/api/generate",
                    json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False, "format": "json"},
                )
                data = response.json()
                content = data.get("response", "").strip()
                if content:
                    try:
                        parsed = json.loads(content)
                        if "reply" in parsed and "voice_instruction" in parsed:
                            return parsed
                    except json.JSONDecodeError:
                        pass
        except Exception as e:
            print(f"⚠️ Ollama error: {e}. Using template fallback.")

    # ─── Fallback template scripts ────────────────────────────────────────────
    reply = _generate_template_script(song_title, artist, requester_name, dedicated_to, story, emotion)
    return {
        "reply": reply,
        "voice_instruction": f"warm, {emotion}, conversational Indian English"
    }


def _generate_template_script(
    song_title: str,
    artist: str,
    requester_name: str,
    dedicated_to: Optional[str],
    story: Optional[str],
    emotion: str
) -> str:
    templates_romantic = [
        f"Aap sun rahe hain Delux Radio... aur yeh waqt hai kuch khaas ke liye. {requester_name} ne request ki hai ek bahut hi pyaari song... aur yeh dedicated hai {dedicated_to or 'kisi khaas insan'} ke liye. Dil mein jo baat hoti hai na... woh kabhi words mein poori nahi utarti. Par yeh song... yeh kuch kehta zaroor hai. Suno dhyan se... {song_title}... {artist} ki awaaz mein.",
        f"Hello Delhi, hello Delux listeners... {requester_name} ne yeh khoobsurat request bheji hai{' for ' + dedicated_to if dedicated_to else ''}. Kuch rishte itne khaas hote hain... jo sirf ek song se hi samajh aate hain. Aur yeh song... yeh woh ehsaas hai. Presenting for you... the beautiful {song_title}.",
    ]
    templates_nostalgic = [
        f"Yeh Delux Radio hai... aur kuch yaadein hoti hain jo kabhi bhoolti nahi. {requester_name} ne aaj woh yaad taaza kar di hai{' for ' + dedicated_to if dedicated_to else ''}. {story or 'Kuch pal aisa hota hai jo dil mein bas jaata hai...'} Aur is pal ke liye... presenting the timeless {song_title} by {artist}.",
        f"Suniye dosto... {requester_name} ki yeh request sunke dil bhar aaya. Woh purane din... woh mohabbat bhari yaadein... sab kuch is ek song mein milta hai. Sirf aapke liye... {song_title}... {artist} ki awaaz mein.",
    ]
    templates_emotional = [
        f"Delux Radio pe aap ka swagat hai... aur aaj {requester_name} ki ek bahut dil se request aayi hai. Zindagi mein kuch lamhe aise hote hain jo hamesha ke liye dil mein reh jaate hain... {story or 'aur woh lamha in ke liye bahut khaas hai.'}  Presenting with lots of love... {song_title} by {artist}.",
    ]
    templates_generic = [
        f"Hello hello Delux family! {requester_name} ki request aayi hai station pe... aur hum to bas yahi kehna chahte hain — shukriya itna pyaar dene ke liye. Aaj ki yeh song sirf unke liye hai{' aur ' + dedicated_to + ' ke liye bhi' if dedicated_to else ''}. Enjoy karo... {song_title} by {artist}. Coming up on Delux Radio!",
    ]

    mapping = {
        "romantic": templates_romantic,
        "nostalgic": templates_nostalgic,
        "emotional": templates_emotional,
        "heartbreak": templates_emotional,
        "friendship": templates_nostalgic,
        "family": templates_emotional,
    }
    pool = mapping.get(emotion, templates_generic)
    return random.choice(pool)
