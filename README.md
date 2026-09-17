# Hangry

Type free-text keywords (e.g. "cheap tacos open late", "gluten free food") and get back real restaurants near your current location,
anywhere in the world.

## How it works

- **Frontend** ([public/index.html](public/index.html), [public/app.js](public/app.js)):
  a single page with a text input. On search, it grabs your lat/lng via the
  browser Geolocation API and calls `/api/search`.
- **Backend** ([api/search.js](api/search.js)): a Vercel serverless function
  that takes `query`, `lat`, `lng`, calls the Google Places Text Search API
  (location-biased around your coordinates), and returns cleaned results
  (name, rating, price level, address, open-now status).
- The Google Places API key is read from the `GOOGLE_PLACES_API_KEY` env var
  on the server and is never sent to or exposed in the frontend.

## Setup

1. Get a Google Places API key: in [Google Cloud Console](https://console.cloud.google.com/),
   create a project, enable the **Places API**, and create an API key.
2. Copy the env file and add your key:

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` and set `GOOGLE_PLACES_API_KEY`.

3. Install dependencies:

   ```bash
   npm install
   ```

4. Run locally:

   ```bash
   npx vercel dev
   ```

   The first run will ask you to link/create a Vercel project — you can
   choose "no" on linking to a scope if you just want local dev, or link
   it if you plan to deploy.

5. Open the printed local URL (typically `http://localhost:3000`), allow
   location access when prompted, and search.

## Notes on this first pass

The raw keyword string is passed straight into the Places Text Search
`query` parameter (with `restaurants` appended and results biased to your
location). No keyword parsing (price, hours, mood, etc.) happens yet — that
comes in a later pass once the end-to-end pipeline is confirmed working.
