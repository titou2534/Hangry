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

# Only the top-ranked results get a fresh closed-business check (one Place
# Details call each). Text Search already flags most closures, and a place
# that is opened gets checked again when its reviews load.
VERIFY_TOP_N = 5

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


async def fetch_page(params: dict) -> dict:
    """One Text Search request: up to 20 results plus a token for the next 20."""
    data = (await get_http().get(TEXT_SEARCH_URL, params=params)).json()
    if data.get("status") not in ("OK", "ZERO_RESULTS"):
        raise ApiError(
            502,
            "Places API request failed",
            status=data.get("status"),
            message=data.get("error_message"),
        )
    return data


def drop_known_closed(places: list[dict]) -> list[dict]:
    return [
        p
        for p in places
        if p.get("business_status") != "CLOSED_PERMANENTLY" and p.get("permanently_closed") is not True
    ]


async def fetch_business_statuses(place_ids: list[str], api_key: str) -> dict[str, str | None]:
    """Text Search's business_status can lag reality, so double-check against
    Place Details, which Google keeps fresher."""
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


async def rank_and_verify(entry: dict, lat: float, lng: float, api_key: str) -> list[dict]:
    """Rank a page of candidates, then closure-check only the top few."""
    ranked = []
    for place in entry["candidates"]:
        location = (place.get("geometry") or {}).get("location")
        distance = distance_meters(lat, lng, location["lat"], location["lng"]) if location else None
        score = rank_score(
            place.get("rating"),
            place.get("user_ratings_total"),
            distance if distance is not None else 8000,
        )
        ranked.append((score, place, location, distance))
    ranked.sort(key=lambda r: r[0], reverse=True)

    # statuses[place_id] exists once a place has been checked (None = unknown).
    # Removing a closed place can pull a new one into the top N, so repeat.
    statuses = entry["statuses"]
    while True:
        still_open = [r for r in ranked if statuses.get(r[1]["place_id"]) != "CLOSED_PERMANENTLY"]
        unchecked = [r[1]["place_id"] for r in still_open[:VERIFY_TOP_N] if r[1]["place_id"] not in statuses]
        if not unchecked:
            break
        statuses.update(await fetch_business_statuses(unchecked, api_key))

    results = []
    for _, place, location, distance in still_open:
        status = statuses.get(place["place_id"])
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
            }
        )
    return results


@router.get("/api/search", dependencies=[Depends(rate_limit("search", 15, 60))])
async def search(
    query: str = Query(..., max_length=200),
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    page_token: str | None = Query(None, alias="pageToken", max_length=2000),
):
    api_key = os.environ.get("GOOGLE_PLACES_API_KEY")
    if not api_key:
        raise ApiError(500, "Server is missing API key configuration")
    if not query.strip():
        raise ApiError(400, "Missing required 'query' parameter")

    # The query was already interpreted by the first search, so on "load more"
    # this is a cache hit and costs no extra Claude call.
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

    if page_token:
        # Google only accepts a page token together with the original search
        # parameters, so it is added on top of them.
        data = await fetch_page({**params, "pagetoken": page_token})
        entry = {
            "candidates": drop_known_closed(data.get("results", [])),
            "statuses": {},
            "next_token": data.get("next_page_token"),
        }
        interpretation = None
    else:
        cache_key = "|".join(
            map(str, [cleaned_query, min_price, max_price, open_now, f"{lat:.3f},{lng:.3f}"])
        )
        entry = _search_cache.get(cache_key)
        if entry is None:
            data = await fetch_page(params)
            entry = {
                "candidates": drop_known_closed(data.get("results", [])),
                "statuses": {},
                "next_token": data.get("next_page_token"),
            }
            _search_cache.set(cache_key, entry)

        interpretation = {
            "parsedBy": interpreted["parsedBy"],
            "searchText": cleaned_query,
            "price": interpreted["price"],
            "openNow": open_now,
        }

    results = await rank_and_verify(entry, lat, lng, api_key)
    return {"results": results, "nextPageToken": entry["next_token"], "interpretation": interpretation}
