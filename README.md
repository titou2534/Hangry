# Hangry

Type what you're craving ("cheap tacos open late", "quiet spot for a first
date", "gluten free food"), snap a photo of a dish (from an instagram story or even a movie), and get real
restaurants near you, with reviews ranked for your search and calorie
estimates for the dishes people recommend.

## Features

- **Natural-language search:** Claude turns free text into filters (food, vibe,
  price, open now), with a keyword-matching fallback if Claude is unavailable.
- **Search by photo:** identifies the dish, including fictional food, and
  searches for the closest real-world version.
- **Ranked results:** rating, review volume, and distance blended into one
  score; sort and filter by price, distance, and rating in the browser.
- **Reviews that match your search:** Claude picks and explains the most
  relevant reviews and pulls out the dishes reviewers loved.
- **Nutrition estimates:** tap a dish for estimated calories and macros.
- **Safeguards:** permanently-closed places are filtered out, requests are
  rate-limited per IP, and expensive lookups are cached.

## Stack

- **Backend:** Python, [FastAPI](https://fastapi.tiangolo.com/), httpx, Pydantic
- **APIs:** Google Places (Text Search, Place Details) and the Anthropic API
- **Frontend:** plain HTML, CSS, and JavaScript in `public/`
- **Hosting:** Vercel

## Project layout

```
app.py              FastAPI app: routes, error handling, local static files
backend/
  search.py         GET  /api/search    query -> ranked restaurants
  details.py        GET  /api/details   reviews ranked for the search
  identify.py       POST /api/identify  photo -> dish + search phrase
  nutrition.py      GET  /api/nutrition calorie and macro estimate
  llm.py            all Claude calls (structured outputs via Pydantic)
  guard.py          rate limiting and TTL cache
public/             frontend (index.html, app.js)
```

API keys stay on the server and are never sent to the browser.

## Run locally

1. Create a Google Cloud API key with the **Places API** enabled, and an
   Anthropic API key from [console.anthropic.com](https://console.anthropic.com).
2. Set up the environment:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env     # then add your two keys
   ```

3. Start the server and open http://localhost:8000:

   ```bash
   uvicorn app:app --reload
   ```

   Interactive API docs are at http://localhost:8000/docs.

Without `ANTHROPIC_API_KEY`, search still works using keyword matching, but
photo search, review summaries, and nutrition estimates are disabled.

## Deploy

```bash
npx vercel --prod
```

Add `GOOGLE_PLACES_API_KEY` and `ANTHROPIC_API_KEY` to the project's
environment variables first (`npx vercel env add NAME production`).

## Known limitations

- Rate limits and caches live in each server instance's memory, so they are
  per-instance. A shared store (e.g. Redis) would make them global.
- Nutrition values are estimates for a typical restaurant serving, not lab
  values, and not suitable for allergen or medical decisions.
- Search takes a few seconds on a cold request because every result is
  re-checked against Google for closed businesses.
