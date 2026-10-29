import os, httpx, asyncio, json
from dotenv import load_dotenv

load_dotenv('backend/.env')
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')

async def test():
    m = 'gemini-3.6-flash'
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={GEMINI_API_KEY}'
    payload = {'contents': [{'parts': [{'text': 'Say hello World in JSON: {"reply": "hello world"}'}]}], 'generationConfig': {'responseMimeType': 'application/json'}}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload)
        if resp.status_code == 200:
            print('SUCCESS!')
            print(resp.json()['candidates'][0]['content']['parts'][0]['text'])
        else:
            print('ERROR:', resp.json())

asyncio.run(test())
