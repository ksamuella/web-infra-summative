'use strict';

const CITIES = require('./cities');

/** An error whose message is safe to show to the end user. */
class WeatherError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.userMessage = message;
  }
}

const r1 = (n) => Math.round(n * 10) / 10;
const sum = (list, f) => list.reduce((s, e) => s + f(e), 0);
const maxOf = (list, f) => Math.max(0, ...list.map(f));

/** Aggregate the 3-hourly entries into the numbers the advice rules use. */
function buildStats(entries) {
  const h24 = entries.slice(0, 8);
  const h48 = entries.slice(0, 16);
  return {
    rain24: r1(sum(h24, (e) => e.rain)),
    popMax24: r1(maxOf(h24, (e) => e.pop)),
    windMax24: r1(maxOf(h24, (e) => e.wind)),
    rain48: r1(sum(h48, (e) => e.rain)),
    popMax48: r1(maxOf(h48, (e) => e.pop)),
    rain5d: r1(sum(entries, (e) => e.rain)),
    tmin5: r1(Math.min(...entries.map((e) => e.temp))),
    tmax5: r1(Math.max(...entries.map((e) => e.temp))),
  };
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Turn an OpenWeather 5-day/3-hour forecast into the compact shape the UI uses. */
function normalizeForecast(city, raw, now = Date.now()) {
  if (!raw || !Array.isArray(raw.list) || raw.list.length < 8) return null;
  const tz = Number(raw.city && raw.city.timezone) || 0;

  const entries = raw.list
    .map((it) => {
      const main = it && it.main;
      if (!main || typeof main.temp !== 'number' || typeof it.dt !== 'number') return null;
      const w = (it.weather && it.weather[0]) || {};
      return {
        t: it.dt * 1000,
        temp: main.temp,
        humidity: typeof main.humidity === 'number' ? main.humidity : 0,
        pop: typeof it.pop === 'number' ? it.pop : 0,
        rain: it.rain && typeof it.rain['3h'] === 'number' ? it.rain['3h'] : 0,
        wind: it.wind && typeof it.wind.speed === 'number' ? it.wind.speed : 0,
        condition: String(w.main || 'Unknown'),
        description: String(w.description || ''),
      };
    })
    .filter(Boolean);
  if (entries.length < 8) return null;

  // Group by the city's local calendar day.
  const byDay = new Map();
  for (const e of entries) {
    const day = new Date(e.t + tz * 1000).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const days = [...byDay.entries()].slice(0, 5).map(([date, list]) => ({
    date,
    tmin: r1(Math.min(...list.map((e) => e.temp))),
    tmax: r1(Math.max(...list.map((e) => e.temp))),
    rain: r1(sum(list, (e) => e.rain)),
    popMax: r1(maxOf(list, (e) => e.pop)),
    condition: mostCommon(list.map((e) => e.condition)),
  }));

  const first = entries[0];
  return {
    id: city.id,
    name: city.name,
    country: city.country,
    lat: city.lat,
    lon: city.lon,
    now: {
      temp: r1(first.temp),
      humidity: first.humidity,
      wind: r1(first.wind),
      condition: first.condition,
      description: first.description,
    },
    stats: buildStats(entries),
    days,
    fetchedAt: new Date(now).toISOString(),
  };
}

/**
 * Weather service: fetches forecasts from OpenWeather with a per-city cache,
 * de-duplication of concurrent requests, and a stale-data fallback.
 * The API key stays on the server and is never sent to the browser.
 */
function createWeatherService({ apiKey, apiBase, ttlMs, fetchImpl = fetch, timeoutMs = 8000 }) {
  const cache = new Map();
  const inflight = new Map();

  async function fetchCity(city) {
    if (!apiKey) {
      throw new WeatherError('The weather service is not configured: the server has no OPENWEATHER_API_KEY.', 503);
    }
    const url = new URL('/data/2.5/forecast', apiBase);
    url.search = new URLSearchParams({
      lat: String(city.lat), lon: String(city.lon), units: 'metric', appid: apiKey,
    }).toString();

    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    } catch {
      throw new WeatherError('The weather service could not be reached.', 502);
    }
    if (res.status === 401) {
      throw new WeatherError('The weather API key was rejected. New OpenWeather keys can take up to 2 hours to activate.', 503);
    }
    if (res.status === 429) {
      throw new WeatherError('The weather provider rate limit was reached. Please try again in a minute.', 503);
    }
    if (!res.ok) throw new WeatherError(`The weather service returned an error (HTTP ${res.status}).`, 502);

    let raw;
    try {
      raw = await res.json();
    } catch {
      throw new WeatherError('The weather service sent an unreadable response.', 502);
    }
    const data = normalizeForecast(city, raw);
    if (!data) throw new WeatherError('The weather service sent unexpected data.', 502);
    return data;
  }

  async function getCity(city, now = Date.now()) {
    const hit = cache.get(city.id);
    if (hit && now - hit.at < ttlMs) return { data: hit.data, stale: false };

    let pending = inflight.get(city.id);
    if (!pending) {
      pending = fetchCity(city)
        .then((data) => {
          cache.set(city.id, { at: Date.now(), data });
          return data;
        })
        .finally(() => inflight.delete(city.id));
      inflight.set(city.id, pending);
    }
    try {
      return { data: await pending, stale: false };
    } catch (err) {
      if (hit) return { data: hit.data, stale: true }; // serve last good data
      throw err;
    }
  }

  async function getAll() {
    const results = await Promise.allSettled(CITIES.map((c) => getCity(c)));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length) throw results[0].reason;
    return {
      cities: ok.map((r) => r.data),
      stale: ok.some((r) => r.stale),
      failed: results.length - ok.length,
    };
  }

  return { getAll, getCity };
}

module.exports = { createWeatherService, normalizeForecast, buildStats, WeatherError };
