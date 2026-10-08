"""GET /api/nutrition

Returns an AI-generated estimate of calories and macros for a dish as a typical
restaurant serves it. Estimates only, not lab values.
"""

import os

from fastapi import APIRouter, Depends, Query

from . import llm
from .errors import ApiError
from .guard import rate_limit

router = APIRouter()


@router.get("/api/nutrition", dependencies=[Depends(rate_limit("nutrition", 20, 60))])
async def nutrition(
    dish: str = Query(..., max_length=80),
    restaurant: str = Query("", max_length=80),
):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise ApiError(503, "Nutrition estimates aren't available right now.")
    if not dish.strip():
        raise ApiError(400, "Missing or invalid 'dish' parameter")

    estimate = await llm.estimate_nutrition(dish, restaurant)
    if estimate is None:
        raise ApiError(502, "Couldn't estimate nutrition. Please try again.")
    if not estimate["isFood"]:
        raise ApiError(422, "That doesn't look like a food or drink.")

    return {"dish": dish.strip(), "nutrition": estimate}
