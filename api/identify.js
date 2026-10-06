// Vercel serverless function: /api/identify
// Accepts a photo (base64) of a dish — real or from film/anime — and returns
// what the dish is plus a search phrase the client feeds into /api/search.
// Images are forwarded to Claude for analysis and never stored.

import { rateLimit } from "./_lib/guard.js";
import { identifyFood, isSupportedImageType } from "./_lib/llm.js";

// The client downsizes photos before upload; Vercel rejects bodies over 4.5MB.
const MAX_BASE64_LENGTH = 3_500_000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Vision calls cost more than text searches, so the limit is tighter.
  if (!rateLimit(req, res, { name: "identify", limit: 6, windowMs: 60_000 })) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "Photo search isn't available right now." });
  }

  const { image, mediaType } = req.body || {};
  if (typeof image !== "string" || !image || !isSupportedImageType(mediaType)) {
    return res.status(400).json({ error: "Send a JPEG, PNG, WebP, or GIF image." });
  }
  if (image.length > MAX_BASE64_LENGTH || !BASE64_PATTERN.test(image)) {
    return res.status(400).json({ error: "That image is too large or isn't valid. Try a smaller photo." });
  }

  const food = await identifyFood(image, mediaType);
  if (!food) {
    return res.status(502).json({ error: "Couldn't analyze that photo. Please try again." });
  }
  if (!food.isFood || !food.searchText) {
    return res.status(422).json({ error: "I couldn't spot any food in that photo. Try a clearer shot of the dish." });
  }

  return res.status(200).json({ food });
}
