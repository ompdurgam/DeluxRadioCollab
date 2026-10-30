"""
TTS Service — Delux Radio
Uses Edge-TTS for highly expressive, lightweight Indian female voice generation.
"""
import os
import asyncio
from pathlib import Path
from typing import Optional
import edge_tts

AUDIO_DIR = Path(__file__).parent.parent / "audio"
AUDIO_DIR.mkdir(exist_ok=True)

async def generate_voice(text: str, voice_instruction: str, output_path: str) -> bool:
    """
    Generate TTS audio for the given text using Edge-TTS.
    Uses Hindi female voice (SwaraNeural) for authentic Bollywood RJ feel,
    with fallback to English-Indian NeerjaNeural.
    Returns True on success, False on failure.
    """
    if not text:
        return False

    # Voice priority: Hindi Swara > English-Indian Neerja
    voices = ["hi-IN-SwaraNeural", "en-IN-NeerjaNeural"]

    for voice in voices:
        try:
            print(f"[TTS] Synthesizing '{text[:40]}...' with Edge-TTS ({voice})...")
            # Slightly slower rate for warm RJ delivery
            communicate = edge_tts.Communicate(text.strip(), voice, rate="-5%")
            await communicate.save(output_path)
            print(f"✅ Edge-TTS generated → {output_path}")
            return True
        except Exception as e:
            print(f"⚠️ Edge-TTS {voice} error: {e}, trying next voice...")

    print(f"❌ All Edge-TTS voices failed")
    return False

def get_audio_path(request_id: int) -> str:
    # edge-tts generates mp3 natively
    return str(AUDIO_DIR / f"rj_{request_id}.mp3")

def get_final_audio_path(request_id: int) -> str:
    # Mixed audio path
    return str(AUDIO_DIR / f"rj_{request_id}_mixed.mp3")

def get_audio_url(request_id: int) -> str:
    # Check if mixed MP3 exists, otherwise fallback to raw Edge-TTS MP3
    if (AUDIO_DIR / f"rj_{request_id}_mixed.mp3").exists():
        return f"/audio/rj_{request_id}_mixed.mp3"
    return f"/audio/rj_{request_id}.mp3"

