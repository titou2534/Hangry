// Vercel serverless function: /api/details
// Given a Google Place ID, fetches recent reviews and extracts a lightweight
// "what people recommend" list by pattern-matching phrases like
// "get the burger" or "the ramen was amazing" across review text.
//
// This is a heuristic, not an AI summary — it just surfaces the noun phrase
// that follows common recommendation/praise verbs, then ranks by frequency.

import { rateLimit, createCache } from "./_lib/guard.js";
import { summarizeReviews } from "./_lib/llm.js";

const PLACE_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json";

const placeCache = createCache({ ttlMs: 6 * 60 * 60_000, maxEntries: 500 });

async function fetchDetails(placeId, apiKey, sort) {
  const params = new URLSearchParams({
    place_id: placeId,
    fields: "name,reviews,url",
    reviews_sort: sort,
    key: apiKey,
  });
  const res = await fetch(`${PLACE_DETAILS_URL}?${params.toString()}`);
  return res.json();
}

// Google returns at most 5 reviews per request. Pulling both sorts gives the
// ranking up to 10 distinct reviews to choose from.
async function fetchPlace(placeId, apiKey) {
  const [relevant, newest] = await Promise.all([
    fetchDetails(placeId, apiKey, "most_relevant"),
    fetchDetails(placeId, apiKey, "newest").catch(() => null),
  ]);

  if (relevant.status !== "OK") {
    const err = new Error(relevant.error_message || relevant.status);
    err.googleStatus = relevant.status;
    throw err;
  }

  const seen = new Set();
  const reviews = [];
  for (const r of [
    ...(relevant.result?.reviews || []),
    ...(newest?.status === "OK" ? newest.result?.reviews || [] : []),
  ]) {
    const key = `${r.author_name}|${r.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reviews.push(r);
  }

  return { name: relevant.result?.name ?? null, url: relevant.result?.url ?? null, reviews };
}

// Keyword fallback: rank reviews by how many distinct search terms they mention.
function rankByKeywords(reviews, searchQuery) {
  const terms = [
    ...new Set(
      searchQuery
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2)
        .map((t) => t.replace(/s$/, ""))
    ),
  ];
  if (terms.length === 0) return [];

  return reviews
    .map((r, index) => {
      const text = (r.text || "").toLowerCase();
      return { index, hits: terms.filter((t) => text.includes(t)).length };
    })
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.index - b.index)
    .slice(0, 4)
    .map((r) => r.index);
}

// Verb phrases that tend to precede a specific menu item in a review. The
// captured group runs to the next clause boundary (comma/period/etc) — we
// trim it down to a short noun phrase afterward in JS.
const RECOMMENDATION_PATTERNS = [
  /\b(?:get|got|order|ordered|try|tried|recommend|recommended|had|have|loved|love)\s+the\s+([a-z][a-z '&-]{2,60})/gi,
  /\bthe\s+([a-z][a-z '&-]{2,60})\s+(?:was|is|were)\s+(?:amazing|incredible|delicious|fantastic|excellent|so good|great|perfect|outstanding)/gi,
];

// Words that mark the end of a dish name and the start of a new clause —
// e.g. "the spicy meltburger with fresh jalapenos" should stop at "with".
const CLAUSE_BOUNDARY_WORDS = new Set([
  "and",
  "with",
  "for",
  "at",
  "in",
  "on",
  "but",
  "which",
  "that",
  "so",
  "because",
  "while",
  "to",
  "from",
  "then",
  "it",
  "which",
]);

// Trims a raw captured phrase down to the dish name itself: stop at the
// first clause-boundary word, and cap length since real menu items are short.
function trimToNounPhrase(phrase, maxWords = 4) {
  const words = phrase.split(/\s+/).filter(Boolean);
  const trimmed = [];
  for (const word of words) {
    if (trimmed.length >= maxWords || CLAUSE_BOUNDARY_WORDS.has(word)) break;
    trimmed.push(word);
  }
  return trimmed.join(" ");
}

// Generic words that occasionally get captured but aren't dishes.
const STOPWORDS = new Set([
  "food",
  "service",
  "place",
  "staff",
  "restaurant",
  "atmosphere",
  "experience",
  "price",
  "menu",
  "vibe",
  "wait",
  "location",
]);

function cleanPhrase(phrase) {
  return phrase
    .trim()
    .replace(/[.,!?;:]+$/, "")
    .toLowerCase();
}

function extractRecommendations(reviews) {
  const counts = new Map();

  for (const review of reviews) {
    const text = review.text || "";
    for (const pattern of RECOMMENDATION_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const phrase = trimToNounPhrase(cleanPhrase(match[1]));
        if (!phrase || STOPWORDS.has(phrase)) continue;
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase, mentions]) => ({ item: phrase, mentions }));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!rateLimit(req, res, { name: "details", limit: 30, windowMs: 60_000 })) return;

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error("GOOGLE_PLACES_API_KEY is not set");
    return res.status(500).json({ error: "Server is missing API key configuration" });
  }

  const { placeId } = req.query;
  if (!placeId || typeof placeId !== "string" || placeId.length > 300) {
    return res.status(400).json({ error: "Missing required 'placeId' parameter" });
  }
  const searchQuery = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";

  try {
    let place = placeCache.get(placeId);
    if (!place) {
      place = await fetchPlace(placeId, apiKey);
      placeCache.set(placeId, place);
    }
    const { reviews } = place;

    // Claude reads the reviews when available; otherwise the regex miner and
    // keyword ranking run.
    const summary = await summarizeReviews(placeId, reviews, searchQuery);
    const recommendations = summary
      ? summary.dishes.map((item) => ({ item, mentions: null }))
      : extractRecommendations(reviews);

    const ranked = summary?.ranked.length
      ? summary.ranked
      : rankByKeywords(reviews, searchQuery).map((index) => ({ index, reason: null }));
    const rankedIndexes = new Set(ranked.map((r) => r.index));
    const ordered = [
      ...ranked,
      ...reviews.map((_, index) => ({ index, reason: null })).filter((r) => !rankedIndexes.has(r.index)),
    ];

    return res.status(200).json({
      name: place.name,
      googleMapsUrl: place.url,
      recommendations,
      vibe: summary?.vibe || null,
      summarizedBy: summary ? "llm" : "regex",
      reviews: ordered.slice(0, 6).map(({ index, reason }) => ({
        author: reviews[index].author_name,
        rating: reviews[index].rating,
        text: reviews[index].text,
        relativeTime: reviews[index].relative_time_description,
        reason,
      })),
    });
  } catch (err) {
    if (err?.googleStatus) {
      console.error("Place Details error:", err.googleStatus, err.message);
      return res.status(502).json({
        error: "Place Details request failed",
        status: err.googleStatus,
        message: err.message,
      });
    }
    console.error("Error calling Place Details API:", err);
    return res.status(500).json({ error: "Failed to fetch place details" });
  }
}
