"""
AI Service — Delux Radio
Uses Ollama + Llama 3 to generate cinematic female RJ scripts.
Falls back to warm template scripts if Ollama is unavailable.
"""
import httpx
import json
import random
import os
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

# Load backend/.env (if not already loaded by main.py)
_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)
    load_dotenv()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:8b")

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


def clean_spoken_text(text: str) -> str:
    """
    Remove all emojis, slashes, markdown formatting, and special characters from spoken RJ text
    so text-to-speech models speak cleanly without pronouncing symbols or stumbling.
    """
    if not text:
        return ""
    import re
    # 1. Remove all emojis using unicode blocks
    emoji_pattern = re.compile(
        "["
        "\U0001F600-\U0001F64F"  # emoticons
        "\U0001F300-\U0001F5FF"  # symbols & pictographs
        "\U0001F680-\U0001F6FF"  # transport & map
        "\U0001F1E0-\U0001F1FF"  # flags
        "\U00002702-\U000027B0"  # dingbats
        "\U000024C2-\U0001F251"
        "\U0001F900-\U0001F9FF"  # supplemental symbols
        "\U0001FA70-\U0001FAFF"  # symbols & pictographs extended
        "\U00002600-\U000026FF"  # miscellaneous symbols
        "]+",
        flags=re.UNICODE
    )
    text = emoji_pattern.sub("", text)

    # 2. Replace slashes with words or space
    text = text.replace("/", " or ").replace("\\", " ")

    # 3. Remove markdown formatting and special characters
    text = re.sub(r'[*_~#`\[\](){}<>|^"\'“”‘’]', '', text)

    # 4. Replace hyphens and em/en dashes with comma
    text = re.sub(r'[-—–]+', ', ', text)

    # 5. Clean excessive dots and whitespace
    text = re.sub(r'\.{4,}', '...', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


async def generate_rj_script(
    song_title: str,
    artist: str,
    requester_name: str,
    dedicated_to: Optional[str] = None,
    story: Optional[str] = None,
    emotion: str = "nostalgic"
) -> str:
    """
    Generate a warm cinematic RJ announcement script mimicking a real live Radio Jockey.
    Interprets listener message and shares it with the public audience.
    Strictly free of emojis, slashes, and special characters.
    """
    dedication_line = f"dedicated to {dedicated_to}" if dedicated_to else ""
    story_line = f"Their message: {story}" if story else ""

    prompt = f"""You are RJ Priya, a real, warm, and charismatic live Radio Jockey broadcasting on Delux Radio, the home of timeless 90s Bollywood melodies. You are on air speaking live on microphone to all the listeners tuned in across the city.

A listener has sent in a heartfelt personal message and song request:
- Listener Name: {requester_name}
- Dedicated To: {dedication_line or 'all Delux Radio listeners'}
- Listener Note and Story: {story_line or 'Sharing love and nostalgic memories'}
- Requested Song: {song_title} by {artist}
- Emotion and Vibe: {emotion}

YOUR TASK AS A REAL RADIO JOCKEY:
1. Deeply understand {requester_name}'s message, personal story, and feelings.
2. Address the whole public listening audience warmly (for example: Dosto, aap sun rahe hain Delux Radio aur main hoon aapki RJ Priya...).
3. Share {requester_name}'s message and dedication with the public audience in an intimate, relatable, and heartfelt way, just like a real late-night FM radio host.
4. Announce the requested song at the very end to build anticipation before it plays for everyone.
5. Language: Natural, engaging Hinglish (Hindi and English mix) that sounds authentic on air.

STRICT FORMATTING AND VOCAL RULES:
- STRICTLY NO EMOJIS: Do not use any emojis at all.
- STRICTLY NO SLASHES: Never use forward slash or backslash.
- STRICTLY NO SPECIAL CHARACTERS OR MARKDOWN: Do not use asterisks, hashtags, underscores, brackets, parentheses, tildes, dashes, or quotation marks. Use only plain letters, numbers, spaces, commas, periods, exclamation marks, and question marks.
- The script must be 100 percent clean spoken text so text-to-speech voice engines can speak it naturally without pronouncing symbols.
- Keep the announcement under 100 words.

You MUST respond with a single JSON object in this exact shape and nothing else:
{{
  "reply": "<plain speakable RJ announcement text with no emojis, no slashes, and no special characters>",
  "voice_instruction": "<warm, {emotion}, expressive, natural radio pacing>"
}}
"""

    gemini_key = os.getenv("GEMINI_API_KEY")
    if gemini_key:
        candidate_models = []
        custom_model = os.getenv("GEMINI_MODEL")
        if custom_model:
            candidate_models.append(custom_model)
        candidate_models.extend(["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.6-flash"])
        # Deduplicate
        seen = set()
        candidate_models = [m for m in candidate_models if not (m in seen or seen.add(m))]

        for model_name in candidate_models:
            try:
                gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={gemini_key}"
                payload = {
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"responseMimeType": "application/json"}
                }
                async with httpx.AsyncClient(timeout=30) as client:
                    response = await client.post(gemini_url, json=payload)
                    if response.status_code == 200:
                        data = response.json()
                        if "candidates" in data and data["candidates"]:
                            text_content = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                            if text_content.startswith("```json"):
                                text_content = text_content[7:-3].strip()
                            elif text_content.startswith("```"):
                                text_content = text_content[3:-3].strip()
                            parsed = json.loads(text_content)
                            if "reply" in parsed and "voice_instruction" in parsed:
                                parsed["reply"] = clean_spoken_text(parsed["reply"])
                                print(f"✅ Gemini ({model_name}) generated RJ script successfully!")
                                return parsed
                    elif response.status_code in (404, 503, 429):
                        print(f"ℹ️ Gemini model {model_name} returned {response.status_code}, trying next model...")
                        continue
                    else:
                        print(f"⚠️ Gemini API returned status {response.status_code} for {model_name}: {response.text[:150]}")
                        continue
            except Exception as e:
                print(f"⚠️ Gemini API error with {model_name}: {e}")

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
                            parsed["reply"] = clean_spoken_text(parsed["reply"])
                            return parsed
                    except json.JSONDecodeError:
                        pass
        except Exception as e:
            print(f"⚠️ Ollama error: {e}. Using template fallback.")

    # ─── Fallback template scripts ────────────────────────────────────────────
    reply = clean_spoken_text(_generate_template_script(song_title, artist, requester_name, dedicated_to, story, emotion))
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
    clean_story = clean_spoken_text(story or "")
    clean_dedication = clean_spoken_text(dedicated_to or "")
    
    templates_romantic = [
        f"Aap sun rahe hain Delux Radio, aur yeh waqt hai kuch khaas ke liye. Hamare listener {requester_name} ne request bheji hai, aur yeh dedicated hai {clean_dedication or 'kisi bahut khaas insan'} ke liye. {clean_story or 'Dil mein jo baat hoti hai na, woh kabhi lafzon mein poori nahi utarti.'} Toh chaliye sunte hain yeh khoobsurat naghma, {song_title}, {artist} ki awaaz mein.",
        f"Hello Delux listeners, main hoon aapki RJ Priya. Hamare pyare listener {requester_name} ne ek dil chhoo lene wali request bheji hai{' for ' + clean_dedication if clean_dedication else ''}. {clean_story or 'Kuch rishte itne khaas hote hain jo sirf ek gaane se samajh aate hain.'} Aap sabhi ke liye, pesh hai {song_title}.",
    ]
    templates_nostalgic = [
        f"Yeh Delux Radio hai, aur kuch yaadein hoti hain jo kabhi bhoolti nahi. {requester_name} ne aaj woh purani yaad taaza kar di hai{' for ' + clean_dedication if clean_dedication else ''}. {clean_story or 'Kuch pal aise hote hain jo hamesha dil mein bas jaate hain.'} Aur is pal ke liye, suniye the timeless {song_title} by {artist}.",
        f"Suniye dosto, {requester_name} ki yeh request sunke dil khush ho gaya. Woh purane din aur woh pyari yaadein sab is ek gaane mein milte hain. Sirf aap sabhi ke liye, {song_title}, {artist} ki awaaz mein.",
    ]
    templates_emotional = [
        f"Delux Radio pe aap sabhi ka swagat hai, aur aaj {requester_name} ki ek dil se aayi request share kar rahi hoon. Zindagi mein kuch lamhe hamesha ke liye dil mein reh jaate hain. {clean_story or 'Yeh lamha inke liye bahut anmol hai.'} Dosto suniye pyaar ke sath, {song_title} by {artist}.",
    ]
    templates_generic = [
        f"Hello hello Delux family! {requester_name} ki pyaari si request aayi hai station pe, aur hum yahi kehna chahte hain ki shukriya itna pyaar dene ke liye. {clean_story or 'Aapka message hamare dil tak pahunch gaya.'} Enjoy kijiye yeh khoobsurat gaana, {song_title} by {artist}, only on Delux Radio!",
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
