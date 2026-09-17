// Vercel serverless function: /api/details
// Given a Google Place ID, fetches recent reviews and extracts a lightweight
// "what people recommend" list by pattern-matching phrases like
// "get the burger" or "the ramen was amazing" across review text.
//
// This is a heuristic, not an AI summary — it just surfaces the noun phrase
// that follows common recommendation/praise verbs, then ranks by frequency.

const PLACE_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json";

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

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error("GOOGLE_PLACES_API_KEY is not set");
    return res.status(500).json({ error: "Server is missing API key configuration" });
  }

  const { placeId } = req.query;
  if (!placeId || typeof placeId !== "string") {
    return res.status(400).json({ error: "Missing required 'placeId' parameter" });
  }

  const params = new URLSearchParams({
    place_id: placeId,
    fields: "name,reviews,url",
    key: apiKey,
  });

  try {
    const detailsRes = await fetch(`${PLACE_DETAILS_URL}?${params.toString()}`);
    const data = await detailsRes.json();

    if (data.status !== "OK") {
      console.error("Place Details error:", data.status, data.error_message);
      return res.status(502).json({
        error: "Place Details request failed",
        status: data.status,
        message: data.error_message,
      });
    }

    const reviews = data.result?.reviews || [];
    const recommendations = extractRecommendations(reviews);

    return res.status(200).json({
      name: data.result?.name ?? null,
      googleMapsUrl: data.result?.url ?? null,
      recommendations,
      reviews: reviews.slice(0, 5).map((r) => ({
        author: r.author_name,
        rating: r.rating,
        text: r.text,
        relativeTime: r.relative_time_description,
      })),
    });
  } catch (err) {
    console.error("Error calling Place Details API:", err);
    return res.status(500).json({ error: "Failed to fetch place details" });
  }
}
