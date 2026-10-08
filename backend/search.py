"""GET /api/search

Takes a free-text request plus the caller's coordinates, asks Google Places for
nearby restaurants (location-biased), and returns a cleaned, ranked list.
The Places API key never leaves the server.
"""

import asyncio
import math
import os

from fastapi import APIRouter, Depends, Query

from . import llm
from .errors import ApiError
from .guard import TTLCache, rate_limit
from .http import get_http

router = APIRouter()

TEXT_SEARCH_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json"
DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"

EARTH_RADIUS_METERS = 6371000
METERS_PER_MILE = 1609.34

# Cached by query + coordinates rounded to ~110m. Distances are still computed
# from the caller's exact position.
_search_cache = TTLCache(10 * 60, 200)

# Fallback keyword parser, used when Claude is unavailable. Pulling price and
# hours words out of the free text and into structured Places parameters keeps
# them from skewing text relevance.
CHEAP_WORDS = ["cheap", "inexpensive", "budget", "affordable"]
MODERATE_WORDS = ["mid-range", "moderate", "moderately priced"]
EXPENSIVE_WORDS = ["expensive", "upscale", "fancy", "fine dining", "pricey"]
OPEN_NOW_WORDS = ["open now", "open late", "still open", "right now", "open right now"]

LLM_PRICE_RANGES = {
    "cheap": {"maxPrice": 1},
    "moderate": {"minPrice": 1, "maxPrice": 2},
    "expensive": {"minPrice": 3},
}


def parse_keywords(raw_query: str) -> dict:
    text = f" {raw_query.lower()} "
    min_price = None
    max_price = None
    open_now = False

    for phrase in OPEN_NOW_WORDS:
        if phrase in text:
            open_now = True
            text = text.replace(phrase, " ", 1)
    for phrase in CHEAP_WORDS:
        if phrase in text:
            max_price = 1
            text = text.replace(phrase, " ", 1)
    for phrase in MODERATE_WORDS:
        if phrase in text:
            min_price, max_price = 1, 2
            text = text.replace(phrase, " ", 1)
    for phrase in EXPENSIVE_WORDS:
        if phrase in text:
            min_price = 3
            text = text.replace(phrase, " ", 1)

    cleaned = " ".join(text.split())
    return {
        "cleanedQuery": cleaned or raw_query.strip(),
        "minPrice": min_price,
        "maxPrice": max_price,
        "openNow": open_now,
    }


async def interpret_query(raw_query: str) -> dict:
    """Prefer Claude's reading of the query; fall back to keyword matching."""
    parsed = await llm.parse_query(raw_query)
    if parsed:
        text = " ".join([parsed["searchText"], *parsed["vibe"]]).strip()
        prices = LLM_PRICE_RANGES.get(parsed["price"], {})
        return {
            "cleanedQuery": text or raw_query.strip(),
            "minPrice": prices.get("minPrice"),
            "maxPrice": prices.get("maxPrice"),
            "openNow": parsed["openNow"],
            "price": parsed["price"],
            "parsedBy": "llm",
        }

    kw = parse_keywords(raw_query)
    if kw["maxPrice"] == 1:
        price = "cheap"
    elif kw["minPrice"] is not None and kw["minPrice"] >= 3:
        price = "expensive"
    elif kw["maxPrice"] == 2:
        price = "moderate"
    else:
        price = "any"
    return {**kw, "price": price, "parsedBy": "regex"}


def distance_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine distance between two lat/lng points, in meters."""
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lng / 2) ** 2
    )
    return EARTH_RADIUS_METERS * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def format_distance(meters: float) -> str:
    miles = meters / METERS_PER_MILE
    return "< 0.1 mi" if miles < 0.1 else f"{miles:.1f} mi"


def rank_score(rating, user_ratings_total, distance_in_meters: float) -> float:
    """Blend rating, review volume (log-scaled) and proximity into one score."""
    rating_score = rating if rating is not None else 3.5
    review_weight = math.log10((user_ratings_total or 0) + 1)
    distance_penalty = distance_in_meters / METERS_PER_MILE
    return rating_score * (1 + review_weight) - distance_penalty * 0.4


async def fetch_all_pages(params: dict, api_key: str, max_pages: int = 3) -> list[dict]:
    """Google paginates in batches of ~20 (max 60). A next_page_token isn't
    valid for a couple of seconds after it is issued."""
    http = get_http()
    results: list[dict] = []
    page_params = params

    for page in range(max_pages):
        data = (await http.get(TEXT_SEARCH_URL, params=page_params)).json()

        if data.get("status") not in ("OK", "ZERO_RESULTS"):
            if page == 0:
                raise ApiError(
                    502,
                    "Places API request failed",
                    status=data.get("status"),
                    message=data.get("error_message"),
                )
            break

        results.extend(data.get("results", []))

        token = data.get("next_page_token")
        if not token:
            break
        await asyncio.sleep(2)
        page_params = {"pagetoken": token, "key": api_key}

    return results


async def fetch_business_statuses(place_ids: list[str], api_key: str) -> dict[str, str | None]:
    """Text Search's business_status can lag reality, so double-check each
    place against Place Details, which Google keeps fresher."""
    http = get_http()

    async def lookup(place_id: str):
        try:
            data = (
                await http.get(
                    DETAILS_URL,
                    params={"place_id": place_id, "fields": "business_status", "key": api_key},
                )
            ).json()
            if data.get("status") == "OK" and data.get("result"):
                return place_id, data["result"].get("business_status")
        except Exception:
            pass
        return place_id, None

    return dict(await asyncio.gather(*(lookup(pid) for pid in place_ids)))


@router.get("/api/search", dependencies=[Depends(rate_limit("search", 15, 60))])
async def search(
    query: str = Query(..., max_length=200),
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
):
    api_key = os.environ.get("GOOGLE_PLACES_API_KEY")
    if not api_key:
        raise ApiError(500, "Server is missing API key configuration")
    if not query.strip():
        raise ApiError(400, "Missing required 'query' parameter")

    interpreted = await interpret_query(query)
    cleaned_query = interpreted["cleanedQuery"]
    min_price, max_price, open_now = (
        interpreted["minPrice"],
        interpreted["maxPrice"],
        interpreted["openNow"],
    )

    # Location is a bias, not a hard filter: Google may return farther results
    # if nothing nearby matches.
    params = {
        "query": f"{cleaned_query} restaurants",
        "location": f"{lat},{lng}",
        "radius": "8000",
        "type": "restaurant",
        "key": api_key,
    }
    if min_price is not None:
        params["minprice"] = str(min_price)
    if max_price is not None:
        params["maxprice"] = str(max_price)
    if open_now:
        params["opennow"] = "true"

    cache_key = "|".join(map(str, [cleaned_query, min_price, max_price, open_now, f"{lat:.3f},{lng:.3f}"]))
    cached = _search_cache.get(cache_key)

    if cached is None:
        raw_results = await fetch_all_pages(params, api_key)

        # First pass: drop anything Text Search already flagged as closed.
        candidates = [
            p
            for p in raw_results
            if p.get("business_status") != "CLOSED_PERMANENTLY" and p.get("permanently_closed") is not True
        ]
        # Second pass: re-verify against Place Details.
        statuses = await fetch_business_statuses([p["place_id"] for p in candidates], api_key)

        cached = {"candidates": candidates, "statuses": statuses}
        _search_cache.set(cache_key, cached)

    results = []
    for place in cached["candidates"]:
        status = cached["statuses"].get(place["place_id"])
        if status == "CLOSED_PERMANENTLY":
            continue

        location = (place.get("geometry") or {}).get("location")
        distance = distance_meters(lat, lng, location["lat"], location["lng"]) if location else None

        results.append(
            {
                "name": place.get("name"),
                "rating": place.get("rating"),
                "userRatingsTotal": place.get("user_ratings_total"),
                "priceLevel": place.get("price_level"),
                "address": place.get("formatted_address") or place.get("vicinity"),
                "openNow": (place.get("opening_hours") or {}).get("open_now"),
                "temporarilyClosed": place.get("business_status") == "CLOSED_TEMPORARILY"
                or status == "CLOSED_TEMPORARILY",
                "placeId": place["place_id"],
                "location": location,
                "distanceMeters": distance,
                "distanceText": format_distance(distance) if distance is not None else None,
                "_score": rank_score(
                    place.get("rating"),
                    place.get("user_ratings_total"),
                    distance if distance is not None else 8000,
                ),
            }
        )

    results.sort(key=lambda r: r["_score"], reverse=True)
    for r in results:
        del r["_score"]

    return {
        "results": results,
        "interpretation": {
            "parsedBy": interpreted["parsedBy"],
            "searchText": cleaned_query,
            "price": interpreted["price"],
            "openNow": open_now,
        },
    }
