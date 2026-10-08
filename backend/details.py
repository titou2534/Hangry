"""GET /api/details

Fetches a place's reviews, has Claude pick the ones most relevant to the
diner's search and summarize standout dishes. Falls back to a regex dish miner
and keyword ranking when Claude is unavailable.
"""

import asyncio
import os
import re

from fastapi import APIRouter, Depends, Query

from . import llm
from .errors import ApiError
from .guard import TTLCache, rate_limit
from .http import get_http

router = APIRouter()

DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"

_place_cache = TTLCache(6 * 60 * 60, 500)

# --- Fallback dish miner -----------------------------------------------------

# Phrases that tend to precede a specific menu item in a review. The captured
# group runs to the next clause boundary; trim_to_noun_phrase shortens it.
RECOMMENDATION_PATTERNS = [
    re.compile(
        r"\b(?:get|got|order|ordered|try|tried|recommend|recommended|had|have|loved|love)\s+the\s+([a-z][a-z '&-]{2,60})",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bthe\s+([a-z][a-z '&-]{2,60})\s+(?:was|is|were)\s+(?:amazing|incredible|delicious|fantastic|excellent|so good|great|perfect|outstanding)",
        re.IGNORECASE,
    ),
]

# Generic words that sometimes get captured but aren't dishes.
STOPWORDS = {"food", "service", "place", "staff", "restaurant", "atmosphere", "experience", "price", "menu", "vibe", "wait", "location"}

# Words that end a dish name and start a new clause.
CLAUSE_BOUNDARY_WORDS = {"and", "with", "for", "at", "in", "on", "but", "which", "that", "so", "because", "while", "to", "from", "then", "it"}


def trim_to_noun_phrase(phrase: str, max_words: int = 4) -> str:
    trimmed = []
    for word in phrase.split():
        if len(trimmed) >= max_words or word in CLAUSE_BOUNDARY_WORDS:
            break
        trimmed.append(word)
    return " ".join(trimmed)


def extract_recommendations(reviews: list[dict]) -> list[dict]:
    counts: dict[str, int] = {}
    for review in reviews:
        text = review.get("text") or ""
        for pattern in RECOMMENDATION_PATTERNS:
            for match in pattern.finditer(text):
                phrase = trim_to_noun_phrase(match.group(1).strip().rstrip(".,!?;:").lower())
                if not phrase or phrase in STOPWORDS:
                    continue
                counts[phrase] = counts.get(phrase, 0) + 1

    top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:5]
    return [{"item": phrase, "mentions": mentions} for phrase, mentions in top]


def rank_by_keywords(reviews: list[dict], search_query: str) -> list[int]:
    """Rank reviews by how many distinct search terms they mention."""
    terms = {re.sub(r"s$", "", t) for t in re.split(r"[^a-z0-9]+", search_query.lower()) if len(t) > 2}
    if not terms:
        return []

    scored = []
    for index, review in enumerate(reviews):
        text = (review.get("text") or "").lower()
        hits = sum(1 for t in terms if t in text)
        if hits:
            scored.append((index, hits))
    scored.sort(key=lambda s: (-s[1], s[0]))
    return [index for index, _ in scored[:4]]


# --- Google fetching ---------------------------------------------------------


async def fetch_details(place_id: str, api_key: str, sort: str) -> dict:
    response = await get_http().get(
        DETAILS_URL,
        params={"place_id": place_id, "fields": "name,reviews,url", "reviews_sort": sort, "key": api_key},
    )
    return response.json()


async def fetch_place(place_id: str, api_key: str) -> dict:
    """Google returns at most 5 reviews per request. Pulling both sorts gives
    the ranking up to 10 distinct reviews to choose from."""
    relevant, newest = await asyncio.gather(
        fetch_details(place_id, api_key, "most_relevant"),
        fetch_details(place_id, api_key, "newest"),
        return_exceptions=True,
    )

    if isinstance(relevant, Exception):
        raise relevant
    if relevant.get("status") != "OK":
        raise ApiError(
            502,
            "Place Details request failed",
            status=relevant.get("status"),
            message=relevant.get("error_message"),
        )

    newest_reviews = []
    if not isinstance(newest, Exception) and newest.get("status") == "OK":
        newest_reviews = newest.get("result", {}).get("reviews", [])

    seen = set()
    reviews = []
    for review in [*relevant.get("result", {}).get("reviews", []), *newest_reviews]:
        key = (review.get("author_name"), review.get("time"))
        if key in seen:
            continue
        seen.add(key)
        reviews.append(review)

    result = relevant.get("result", {})
    return {"name": result.get("name"), "url": result.get("url"), "reviews": reviews}


@router.get("/api/details", dependencies=[Depends(rate_limit("details", 30, 60))])
async def details(
    place_id: str = Query(..., alias="placeId", min_length=1, max_length=300),
    q: str = Query("", max_length=200),
):
    api_key = os.environ.get("GOOGLE_PLACES_API_KEY")
    if not api_key:
        raise ApiError(500, "Server is missing API key configuration")

    search_query = q.strip()

    place = _place_cache.get(place_id)
    if place is None:
        place = await fetch_place(place_id, api_key)
        _place_cache.set(place_id, place)
    reviews = place["reviews"]

    # Claude reads the reviews when available; otherwise the regex miner and
    # keyword ranking run.
    summary = await llm.summarize_reviews(place_id, reviews, search_query)
    recommendations = (
        [{"item": item, "mentions": None} for item in summary["dishes"]]
        if summary
        else extract_recommendations(reviews)
    )

    if summary and summary["ranked"]:
        ranked = summary["ranked"]
    else:
        ranked = [{"index": i, "reason": None} for i in rank_by_keywords(reviews, search_query)]
    ranked_indexes = {r["index"] for r in ranked}
    ordered = [*ranked, *({"index": i, "reason": None} for i in range(len(reviews)) if i not in ranked_indexes)]

    return {
        "name": place["name"],
        "googleMapsUrl": place["url"],
        "recommendations": recommendations,
        "vibe": (summary or {}).get("vibe") or None,
        "summarizedBy": "llm" if summary else "regex",
        "reviews": [
            {
                "author": reviews[item["index"]].get("author_name"),
                "rating": reviews[item["index"]].get("rating"),
                "text": reviews[item["index"]].get("text"),
                "relativeTime": reviews[item["index"]].get("relative_time_description"),
                "reason": item["reason"],
            }
            for item in ordered[:6]
        ],
    }
