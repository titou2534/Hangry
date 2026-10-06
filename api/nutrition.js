// Vercel serverless function: /api/nutrition
// Returns an AI-generated estimate of calories and macros for a dish as a
// typical restaurant serves it. Estimates only — not lab values.

import { rateLimit } from "./_lib/guard.js";
import { estimateNutrition } from "./_lib/llm.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!rateLimit(req, res, { name: "nutrition", limit: 20, windowMs: 60_000 })) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "Nutrition estimates aren't available right now." });
  }

  const { dish, restaurant } = req.query;
  if (typeof dish !== "string" || !dish.trim() || dish.length > 80) {
    return res.status(400).json({ error: "Missing or invalid 'dish' parameter" });
  }
  if (restaurant !== undefined && (typeof restaurant !== "string" || restaurant.length > 80)) {
    return res.status(400).json({ error: "Invalid 'restaurant' parameter" });
  }

  const nutrition = await estimateNutrition(dish, restaurant || "");
  if (!nutrition) {
    return res.status(502).json({ error: "Couldn't estimate nutrition. Please try again." });
  }
  if (!nutrition.isFood) {
    return res.status(422).json({ error: "That doesn't look like a food or drink." });
  }

  return res.status(200).json({ dish: dish.trim(), nutrition });
}
