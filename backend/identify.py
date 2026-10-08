"""POST /api/identify

Accepts a photo (base64) of a dish, real or from film/anime, and returns what
the dish is plus a search phrase the client feeds into /api/search. Images are
forwarded to Claude for analysis and never stored.
"""

import os
import re

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from . import llm
from .errors import ApiError
from .guard import rate_limit

router = APIRouter()

# The client downsizes photos before upload; Vercel rejects bodies over 4.5MB.
MAX_BASE64_LENGTH = 3_500_000
BASE64_PATTERN = re.compile(r"[A-Za-z0-9+/]+={0,2}")


class IdentifyBody(BaseModel):
    image: str = ""
    mediaType: str = ""


# Vision calls cost more than text searches, so the limit is tighter.
@router.post("/api/identify", dependencies=[Depends(rate_limit("identify", 6, 60))])
async def identify(body: IdentifyBody):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise ApiError(503, "Photo search isn't available right now.")

    if not body.image or not llm.is_supported_image_type(body.mediaType):
        raise ApiError(400, "Send a JPEG, PNG, WebP, or GIF image.")
    if len(body.image) > MAX_BASE64_LENGTH or not BASE64_PATTERN.fullmatch(body.image):
        raise ApiError(400, "That image is too large or isn't valid. Try a smaller photo.")

    food = await llm.identify_food(body.image, body.mediaType)
    if food is None:
        raise ApiError(502, "Couldn't analyze that photo. Please try again.")
    if not food["isFood"] or not food["searchText"]:
        raise ApiError(422, "I couldn't spot any food in that photo. Try a clearer shot of the dish.")

    return {"food": food}
