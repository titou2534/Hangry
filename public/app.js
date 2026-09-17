const form = document.getElementById("search-form");
const input = document.getElementById("query-input");
const button = document.getElementById("search-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const controlsEl = document.getElementById("controls");
const sortSelect = document.getElementById("sort-select");
const distanceSelect = document.getElementById("distance-select");
const priceCheckboxes = Array.from(document.querySelectorAll("#price-filters input"));

let cachedPosition = null;
let lastResults = [];

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
      (hiddenByFilters > 0 ? ` (${hiddenByFilters} hidden by filters)` : "")
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

    card.addEventListener("click", () => toggleDetails(card, place));

    resultsEl.appendChild(card);
  }
}

const detailsCache = new Map();

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
    let data = detailsCache.get(place.placeId);
    if (!data) {
      const params = new URLSearchParams({ placeId: place.placeId });
      const response = await fetch(`/api/details?${params.toString()}`);
      data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load details");
      detailsCache.set(place.placeId, data);
    }

    // The card may have been collapsed while the request was in flight.
    if (!card.contains(detailsEl)) return;

    detailsEl.classList.remove("loading");
    detailsEl.innerHTML = "";

    if (data.recommendations && data.recommendations.length > 0) {
      const heading = document.createElement("div");
      heading.style.fontWeight = "600";
      heading.style.marginBottom = "6px";
      heading.textContent = "Recommended by reviewers";
      detailsEl.appendChild(heading);

      const chipRow = document.createElement("div");
      for (const rec of data.recommendations) {
        const chip = document.createElement("span");
        chip.className = "recommend-chip";
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
      reviewsHeading.textContent = "Recent reviews";
      detailsEl.appendChild(reviewsHeading);

      for (const review of data.reviews.slice(0, 3)) {
        const snippet = document.createElement("div");
        snippet.className = "review-snippet";

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

async function handleSearch(event) {
  event.preventDefault();

  const query = input.value.trim();
  if (!query) return;

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

form.addEventListener("submit", handleSearch);
sortSelect.addEventListener("change", applyFiltersAndSort);
distanceSelect.addEventListener("change", applyFiltersAndSort);
priceCheckboxes.forEach((cb) => cb.addEventListener("change", applyFiltersAndSort));
