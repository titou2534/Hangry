// Vercel serverless function: /api/search
// Takes a free-text keyword + lat/lng, calls Google Places Text Search
// (location-biased), and returns a cleaned, ranked list of restaurants.
//
// The Places API key never leaves the server — it's read from the
// GOOGLE_PLACES_API_KEY env var, not passed to or from the client.

const PLACES_TEXT_SEARCH_URL =
  "https://maps.googleapis.com/maps/api/place/textsearch/json";
const PLACE_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json";

const EARTH_RADIUS_METERS = 6371000;

// Words that hint at price level or hours. Pulling these out of the free-text
// query and into structured Places API params keeps them from skewing text
// relevance (e.g. "cheap" was burying well-known cheap chains like McDonald's
// behind boutique burger spots whose descriptions matched "cheap" better).
const CHEAP_WORDS = ["cheap", "inexpensive", "budget", "affordable"];
const MODERATE_WORDS = ["mid-range", "moderate", "moderately priced"];
const EXPENSIVE_WORDS = ["expensive", "upscale", "fancy", "fine dining", "pricey"];
const OPEN_NOW_WORDS = ["open now", "open late", "still open", "right now", "open right now"];

function parseKeywords(rawQuery) {
  let text = ` ${rawQuery.toLowerCase()} `;
  let minPrice;
  let maxPrice;
  let openNow = false;

  for (const phrase of OPEN_NOW_WORDS) {
    if (text.includes(phrase)) {
      openNow = true;
      text = text.replace(phrase, " ");
    }
  }
  for (const phrase of CHEAP_WORDS) {
    if (text.includes(phrase)) {
      maxPrice = 1;
      text = text.replace(phrase, " ");
    }
  }
  for (const phrase of MODERATE_WORDS) {
    if (text.includes(phrase)) {
      minPrice = 1;
      maxPrice = 2;
      text = text.replace(phrase, " ");
    }
  }
  for (const phrase of EXPENSIVE_WORDS) {
    if (text.includes(phrase)) {
      minPrice = 3;
      text = text.replace(phrase, " ");
    }
  }

  const cleanedQuery = text.replace(/\s+/g, " ").trim();

  return { cleanedQuery: cleanedQuery || rawQuery.trim(), minPrice, maxPrice, openNow };
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

// Haversine distance between two lat/lng points, in meters.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

function formatDistance(meters) {
  const miles = meters / 1609.34;
  if (miles < 0.1) return "< 0.1 mi";
  return `${miles.toFixed(1)} mi`;
}

// Blend rating, review volume, and proximity into one ranking score so a
// well-reviewed or very close place isn't buried by raw text-relevance order.
// Review count is log-scaled so a place with thousands of ratings doesn't
// completely dominate one with dozens but a solid rating.
function rankScore(rating, userRatingsTotal, distanceInMeters) {
  const ratingScore = rating ?? 3.5;
  const reviewWeight = Math.log10((userRatingsTotal ?? 0) + 1);
  const distancePenalty = distanceInMeters / 1609.34; // miles
  return ratingScore * (1 + reviewWeight) - distancePenalty * 0.4;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Google Text Search paginates in batches of ~20, up to 60 total. A
// next_page_token isn't valid for a couple seconds after it's issued.
async function fetchAllPages(baseUrl, maxPages = 3) {
  const allResults = [];
  let pageUrl = baseUrl;

  for (let page = 0; page < maxPages; page++) {
    const res = await fetch(pageUrl);
    const data = await res.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      if (page === 0) throw data;
      break;
    }

    allResults.push(...(data.results || []));

    if (!data.next_page_token) break;

    await sleep(2000);
    pageUrl = `${PLACES_TEXT_SEARCH_URL}?pagetoken=${data.next_page_token}&key=${
      new URL(baseUrl).searchParams.get("key")
    }`;
  }

  return allResults;
}

// Text Search's business_status can lag reality for stale listings. Place
// Details is Google's more actively-maintained source for current status, so
// we double-check any place that Text Search didn't already flag as closed.
async function fetchBusinessStatuses(placeIds, apiKey) {
  const statusById = new Map();

  await Promise.all(
    placeIds.map(async (placeId) => {
      try {
        const params = new URLSearchParams({
          place_id: placeId,
          fields: "business_status",
          key: apiKey,
        });
        const res = await fetch(`${PLACE_DETAILS_URL}?${params.toString()}`);
        const data = await res.json();
        if (data.status === "OK" && data.result) {
          statusById.set(placeId, data.result.business_status ?? null);
        }
      } catch (err) {
        console.error("Place Details lookup failed for", placeId, err);
      }
    })
  );

  return statusById;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error("GOOGLE_PLACES_API_KEY is not set");
    return res.status(500).json({ error: "Server is missing API key configuration" });
  }

  const { query, lat, lng } = req.query;

  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "Missing required 'query' parameter" });
  }
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "Missing required 'lat'/'lng' parameters" });
  }

  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: "'lat'/'lng' must be valid numbers" });
  }

  const { cleanedQuery, minPrice, maxPrice, openNow } = parseKeywords(query);

  // Bias the text search toward the user's location. Radius is in meters;
  // 8km is a reasonable "nearby" default for a first pass.
  const params = new URLSearchParams({
    query: `${cleanedQuery} restaurants`,
    location: `${latitude},${longitude}`,
    radius: "8000",
    type: "restaurant",
    key: apiKey,
  });
  if (minPrice !== undefined) params.set("minprice", String(minPrice));
  if (maxPrice !== undefined) params.set("maxprice", String(maxPrice));
  if (openNow) params.set("opennow", "true");

  const url = `${PLACES_TEXT_SEARCH_URL}?${params.toString()}`;

  try {
    const rawResults = await fetchAllPages(url);

    // First pass: drop anything Text Search already flagged as closed.
    const candidates = rawResults.filter(
      (place) =>
        place.business_status !== "CLOSED_PERMANENTLY" && place.permanently_closed !== true
    );

    // Second pass: re-verify against Place Details, which tends to have
    // fresher status data than Text Search for listings Google is slow to
    // update.
    const statusById = await fetchBusinessStatuses(
      candidates.map((p) => p.place_id),
      apiKey
    );

    const results = candidates
      .filter((place) => statusById.get(place.place_id) !== "CLOSED_PERMANENTLY")
      .map((place) => {
        const location = place.geometry?.location ?? null;
        const distance = location
          ? distanceMeters(latitude, longitude, location.lat, location.lng)
          : null;

        return {
          name: place.name,
          rating: place.rating ?? null,
          userRatingsTotal: place.user_ratings_total ?? null,
          priceLevel: place.price_level ?? null,
          address: place.formatted_address ?? place.vicinity ?? null,
          openNow: place.opening_hours?.open_now ?? null,
          temporarilyClosed:
            place.business_status === "CLOSED_TEMPORARILY" ||
            statusById.get(place.place_id) === "CLOSED_TEMPORARILY",
          placeId: place.place_id,
          location,
          distanceMeters: distance,
          distanceText: distance !== null ? formatDistance(distance) : null,
          _score: rankScore(place.rating, place.user_ratings_total, distance ?? 8000),
        };
      })
      .sort((a, b) => b._score - a._score)
      .map(({ _score, ...place }) => place);

    return res.status(200).json({ results });
  } catch (err) {
    console.error("Error calling Places API:", err);
    if (err && err.status) {
      return res.status(502).json({
        error: "Places API request failed",
        status: err.status,
        message: err.error_message,
      });
    }
    return res.status(500).json({ error: "Failed to fetch results" });
  }
}
