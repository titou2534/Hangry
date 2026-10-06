const form = document.getElementById("search-form");
const input = document.getElementById("query-input");
const button = document.getElementById("search-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const controlsEl = document.getElementById("controls");
const sortSelect = document.getElementById("sort-select");
const distanceSelect = document.getElementById("distance-select");
const priceCheckboxes = Array.from(document.querySelectorAll("#price-filters input"));
const photoInput = document.getElementById("photo-input");
const photoLabel = document.getElementById("photo-label");
const photoResultEl = document.getElementById("photo-result");

let cachedPosition = null;
let lastResults = [];
let lastInterpretation = null;
let lastQuery = "";

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function getPosition() {
  if (cachedPosition) return Promise.resolve(cachedPosition);

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported by this browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        cachedPosition = position;
        resolve(position);
      },
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

function priceLevelToText(level) {
  if (level === null || level === undefined) return null;
  return "$".repeat(Math.max(1, level));
}

function getCheckedPriceLevels() {
  return priceCheckboxes.filter((cb) => cb.checked).map((cb) => Number(cb.value));
}

function describeInterpretation() {
  if (!lastInterpretation) return "";
  const parts = [];
  if (lastInterpretation.price && lastInterpretation.price !== "any") {
    parts.push(lastInterpretation.price);
  }
  if (lastInterpretation.openNow) parts.push("open now");
  const filters = parts.length ? ` (${parts.join(", ")})` : "";
  return ` · searched for "${lastInterpretation.searchText}"${filters}`;
}

function applyFiltersAndSort() {
  const maxDistance = distanceSelect.value === "any" ? null : Number(distanceSelect.value);
  const checkedPrices = getCheckedPriceLevels();
  const sortBy = sortSelect.value;

  let filtered = lastResults.filter((place) => {
    if (maxDistance !== null) {
      const miles = place.distanceMeters !== null ? place.distanceMeters / 1609.34 : null;
      if (miles !== null && miles > maxDistance) return false;
    }
    // Places with no price data are always kept — we can't tell if they'd match the filter.
    if (place.priceLevel !== null && place.priceLevel !== undefined) {
      if (!checkedPrices.includes(place.priceLevel)) return false;
    }
    return true;
  });

  const sorted = [...filtered];
  if (sortBy === "distance") {
    sorted.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
  } else if (sortBy === "rating") {
    sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  } else if (sortBy === "price-low") {
    sorted.sort((a, b) => (a.priceLevel ?? 99) - (b.priceLevel ?? 99));
  } else if (sortBy === "price-high") {
    sorted.sort((a, b) => (b.priceLevel ?? -1) - (a.priceLevel ?? -1));
  }
  // "best" keeps the server's blended relevance/rating/distance ranking as-is.

  renderResults(sorted, { totalBeforeFilters: lastResults.length });
}

function renderResults(results, { totalBeforeFilters } = {}) {
  resultsEl.innerHTML = "";

  if (lastResults.length === 0) {
    setStatus("No restaurants found. Try different keywords.");
    return;
  }

  if (results.length === 0) {
    setStatus("No results match your filters. Try widening them.");
    return;
  }

  const hiddenByFilters =
    totalBeforeFilters !== undefined ? totalBeforeFilters - results.length : 0;
  setStatus(
    `${results.length} result${results.length === 1 ? "" : "s"}` +
      (hiddenByFilters > 0 ? ` (${hiddenByFilters} hidden by filters)` : "") +
      describeInterpretation()
  );

  for (const place of results) {
    const card = document.createElement("div");
    card.className = "result";
    card.dataset.placeId = place.placeId;

    const title = document.createElement("h3");
    title.textContent = place.name;
    card.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "meta";

    if (place.rating !== null) {
      const rating = document.createElement("span");
      rating.textContent = `★ ${place.rating}${
        place.userRatingsTotal ? ` (${place.userRatingsTotal})` : ""
      }`;
      meta.appendChild(rating);
    }

    const priceText = priceLevelToText(place.priceLevel);
    if (priceText) {
      const price = document.createElement("span");
      price.textContent = priceText;
      meta.appendChild(price);
    }

    if (place.temporarilyClosed) {
      const closedStatus = document.createElement("span");
      closedStatus.textContent = "Temporarily closed";
      closedStatus.className = "closed-now";
      meta.appendChild(closedStatus);
    } else if (place.openNow !== null) {
      const openStatus = document.createElement("span");
      openStatus.textContent = place.openNow ? "Open now" : "Closed now";
      openStatus.className = place.openNow ? "open-now" : "closed-now";
      meta.appendChild(openStatus);
    }

    if (place.distanceText) {
      const distance = document.createElement("span");
      distance.textContent = place.distanceText;
      meta.appendChild(distance);
    }

    card.appendChild(meta);

    if (place.address) {
      const address = document.createElement("div");
      address.className = "address";
      address.textContent = place.address;
      card.appendChild(address);
    }

    card.addEventListener("click", (e) => {
      if (e.target.closest(".details")) return;
      toggleDetails(card, place);
    });

    resultsEl.appendChild(card);
  }
}

const detailsCache = new Map();

const nutritionCache = new Map();

function nutritionStat(label, value) {
  const stat = document.createElement("div");
  stat.className = "nutrition-stat";
  const v = document.createElement("div");
  v.className = "value";
  v.textContent = value;
  const l = document.createElement("div");
  l.className = "label";
  l.textContent = label;
  stat.append(v, l);
  return stat;
}

// Shows (or hides) an estimated-nutrition panel at the end of `container`.
async function toggleNutrition(container, trigger, dish, restaurant) {
  const existing = container.querySelector(":scope > .nutrition");
  const sameDish = existing && existing.dataset.dish === dish;
  if (existing) existing.remove();
  container.querySelectorAll(".tappable.active").forEach((el) => el.classList.remove("active"));
  if (sameDish) return;

  trigger.classList.add("active");
  const panel = document.createElement("div");
  panel.className = "nutrition loading";
  panel.dataset.dish = dish;
  panel.textContent = `Estimating nutrition for ${dish}...`;
  container.appendChild(panel);

  try {
    const key = `${dish}|${restaurant}`;
    let data = nutritionCache.get(key);
    if (!data) {
      const params = new URLSearchParams({ dish });
      if (restaurant) params.set("restaurant", restaurant);
      const response = await fetch(`/api/nutrition?${params.toString()}`);
      data = await response.json();
      if (!response.ok) throw new Error(data.error || "Couldn't estimate nutrition.");
      nutritionCache.set(key, data);
    }
    if (!panel.isConnected) return;

    const n = data.nutrition;
    panel.classList.remove("loading");
    panel.textContent = "";

    const head = document.createElement("div");
    head.className = "nutrition-head";
    head.textContent = `Estimated nutrition: ${dish}`;
    panel.appendChild(head);

    const stats = document.createElement("div");
    stats.className = "nutrition-stats";
    stats.append(
      nutritionStat("calories", `${n.calories}`),
      nutritionStat("protein", `${n.proteinG}g`),
      nutritionStat("carbs", `${n.carbsG}g`),
      nutritionStat("fat", `${n.fatG}g`),
      nutritionStat("sodium", `${n.sodiumMg}mg`)
    );
    panel.appendChild(stats);

    const serving = document.createElement("div");
    serving.className = "nutrition-note";
    serving.textContent = `Per serving: ${n.serving}. ${n.note}`;
    panel.appendChild(serving);

    const disclaimer = document.createElement("div");
    disclaimer.className = "nutrition-note";
    disclaimer.textContent =
      "Estimate for a typical restaurant serving. Real values vary; not for allergen or medical use.";
    panel.appendChild(disclaimer);
  } catch (err) {
    console.error(err);
    if (panel.isConnected) {
      panel.classList.remove("loading");
      panel.textContent = err.message || "Couldn't estimate nutrition.";
    }
    trigger.classList.remove("active");
  }
}

async function toggleDetails(card, place) {
  const existing = card.querySelector(".details");
  if (existing) {
    existing.remove();
    return;
  }

  const detailsEl = document.createElement("div");
  detailsEl.className = "details loading";
  detailsEl.textContent = "Loading what people recommend...";
  card.appendChild(detailsEl);

  try {
    const cacheKey = `${place.placeId}|${lastQuery}`;
    let data = detailsCache.get(cacheKey);
    if (!data) {
      const params = new URLSearchParams({ placeId: place.placeId, q: lastQuery });
      const response = await fetch(`/api/details?${params.toString()}`);
      data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load details");
      detailsCache.set(cacheKey, data);
    }

    // The card may have been collapsed while the request was in flight.
    if (!card.contains(detailsEl)) return;

    detailsEl.classList.remove("loading");
    detailsEl.innerHTML = "";

    if (data.vibe) {
      const vibe = document.createElement("div");
      vibe.style.marginBottom = "8px";
      vibe.style.fontStyle = "italic";
      vibe.textContent = data.vibe;
      detailsEl.appendChild(vibe);
    }

    if (data.recommendations && data.recommendations.length > 0) {
      const heading = document.createElement("div");
      heading.style.fontWeight = "600";
      heading.style.marginBottom = "6px";
      heading.textContent = "Recommended by reviewers";
      detailsEl.appendChild(heading);

      const chipRow = document.createElement("div");
      for (const rec of data.recommendations) {
        const chip = document.createElement("span");
        chip.className = "recommend-chip tappable";
        chip.title = "Tap for a calorie estimate";
        chip.addEventListener("click", () => toggleNutrition(chipRow, chip, rec.item, place.name));
        chip.textContent =
          rec.mentions > 1 ? `${rec.item} (${rec.mentions}x)` : rec.item;
        chipRow.appendChild(chip);
      }
      detailsEl.appendChild(chipRow);
    } else {
      const none = document.createElement("div");
      none.style.color = "#888";
      none.style.marginBottom = "6px";
      none.textContent = "No standout menu items found in recent reviews.";
      detailsEl.appendChild(none);
    }

    if (data.reviews && data.reviews.length > 0) {
      const reviewsHeading = document.createElement("div");
      reviewsHeading.style.fontWeight = "600";
      reviewsHeading.style.margin = "10px 0 6px";
      reviewsHeading.textContent = lastQuery ? `Reviews about "${lastQuery}"` : "Reviews";
      detailsEl.appendChild(reviewsHeading);

      for (const review of data.reviews.slice(0, 4)) {
        const snippet = document.createElement("div");
        snippet.className = "review-snippet";

        if (review.reason) {
          const why = document.createElement("div");
          why.className = "review-why";
          why.textContent = review.reason;
          snippet.appendChild(why);
        }

        const meta = document.createElement("div");
        meta.className = "review-meta";
        meta.textContent = `${review.author} · ★ ${review.rating} · ${review.relativeTime}`;
        snippet.appendChild(meta);

        const text = document.createElement("div");
        text.textContent = review.text;
        snippet.appendChild(text);

        detailsEl.appendChild(snippet);
      }
    }

    if (data.googleMapsUrl) {
      const link = document.createElement("a");
      link.href = data.googleMapsUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "View on Google Maps →";
      link.style.display = "inline-block";
      link.style.marginTop = "6px";
      link.addEventListener("click", (e) => e.stopPropagation());
      detailsEl.appendChild(link);
    }
  } catch (err) {
    console.error(err);
    if (card.contains(detailsEl)) {
      detailsEl.classList.remove("loading");
      detailsEl.textContent = "Couldn't load details for this place.";
    }
  }
}

function handleSearch(event) {
  event.preventDefault();
  photoResultEl.hidden = true;
  return runSearch(input.value.trim());
}

async function runSearch(query) {
  if (!query) return;
  lastQuery = query;

  button.disabled = true;
  resultsEl.innerHTML = "";
  controlsEl.classList.remove("visible");
  setStatus("Getting your location...");

  try {
    const position = await getPosition();
    const { latitude, longitude } = position.coords;

    setStatus("Searching...");

    const params = new URLSearchParams({
      query,
      lat: String(latitude),
      lng: String(longitude),
    });

    const response = await fetch(`/api/search?${params.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Search failed");
    }

    lastResults = data.results || [];
    lastInterpretation = data.interpretation || null;

    // Reset filter/sort controls for the new search.
    sortSelect.value = "best";
    distanceSelect.value = "any";
    priceCheckboxes.forEach((cb) => (cb.checked = true));

    controlsEl.classList.toggle("visible", lastResults.length > 0);
    applyFiltersAndSort();
  } catch (err) {
    console.error(err);
    if (err.code === 1) {
      setStatus("Location access was denied. Please allow location access and try again.", true);
    } else {
      setStatus(err.message || "Something went wrong. Please try again.", true);
    }
  } finally {
    button.disabled = false;
  }
}

// Downsize before upload: phone photos are several MB, and the API body limit is 4.5MB.
async function prepareImage(file) {
  const MAX_SIDE = 1024;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("Couldn't read that image.");

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Couldn't read that image."));
    reader.readAsDataURL(blob);
  });
  return { base64: dataUrl.split(",")[1], previewUrl: dataUrl };
}

function showPhotoResult(food, previewUrl) {
  photoResultEl.innerHTML = "";

  const img = document.createElement("img");
  img.src = previewUrl;
  img.alt = "Your photo";
  photoResultEl.appendChild(img);

  const text = document.createElement("div");

  const dish = document.createElement("div");
  dish.className = "dish";
  dish.textContent = food.dish;
  text.appendChild(dish);

  const desc = document.createElement("div");
  desc.className = "note";
  desc.textContent = food.description;
  text.appendChild(desc);

  const notes = [];
  if (food.fictional) {
    notes.push(
      food.source
        ? `From ${food.source} — showing the real-world version`
        : "Fictional dish — showing the real-world version"
    );
  }
  if (food.confidence === "low") notes.push("Not very sure about this one");
  if (notes.length) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = notes.join(" · ");
    text.appendChild(note);
  }

  const nutritionBtn = document.createElement("button");
  nutritionBtn.type = "button";
  nutritionBtn.className = "nutrition-btn tappable";
  nutritionBtn.textContent = "Nutrition estimate";
  nutritionBtn.addEventListener("click", () => toggleNutrition(text, nutritionBtn, food.dish, ""));
  text.appendChild(nutritionBtn);

  photoResultEl.appendChild(text);
  photoResultEl.hidden = false;
}

async function handlePhoto() {
  const file = photoInput.files[0];
  photoInput.value = "";
  if (!file) return;

  photoLabel.classList.add("busy");
  photoResultEl.hidden = true;
  resultsEl.innerHTML = "";
  controlsEl.classList.remove("visible");
  setStatus("Looking at your photo...");

  try {
    const { base64, previewUrl } = await prepareImage(file);

    const response = await fetch("/api/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, mediaType: "image/jpeg" }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Couldn't analyze that photo.");

    showPhotoResult(data.food, previewUrl);
    input.value = data.food.searchText;
    await runSearch(data.food.searchText);
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Something went wrong with that photo. Please try again.", true);
  } finally {
    photoLabel.classList.remove("busy");
  }
}

form.addEventListener("submit", handleSearch);
photoInput.addEventListener("change", handlePhoto);
sortSelect.addEventListener("change", applyFiltersAndSort);
distanceSelect.addEventListener("change", applyFiltersAndSort);
priceCheckboxes.forEach((cb) => cb.addEventListener("change", applyFiltersAndSort));
