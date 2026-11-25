'use strict';

/**
 * Rule-based farm advice. Pure functions, so they are easy to test.
 * `stats` comes from weather.js (all values metric: mm, m/s, deg C, pop 0..1).
 * Advice text is always written in metric units.
 */

const CROPS = {
  maize: { label: 'Maize', minTemp: 10, maxTemp: 35, wantRain5d: 25 },
  beans: { label: 'Beans', minTemp: 12, maxTemp: 30, wantRain5d: 20 },
  coffee: { label: 'Coffee', minTemp: 12, maxTemp: 28, wantRain5d: 15 },
  potato: { label: 'Irish potato', minTemp: 7, maxTemp: 25, wantRain5d: 20 },
};

const WIND_LIMIT_MS = 5; // above this, spraying drifts
const r0 = (n) => Math.round(n);

function item(task, status, text) {
  return { task, status, text };
}

/** Returns { score: 0-100, items: [{ task, status: good|wait|warn, text }] } */
function computeAdvice(stats, cropKey) {
  const crop = CROPS[cropKey] || CROPS.maize;
  const items = [];

  // Planting
  if (stats.tmin5 < crop.minTemp) {
    items.push(item('Planting', 'wait',
      `Temperatures drop to ${r0(stats.tmin5)}°C, below the ${crop.minTemp}°C that ${crop.label.toLowerCase()} needs. Wait for warmer weather.`));
  } else if (stats.tmax5 > crop.maxTemp) {
    items.push(item('Planting', 'wait',
      `Highs of ${r0(stats.tmax5)}°C exceed the ${crop.maxTemp}°C limit for ${crop.label.toLowerCase()}. Delay planting.`));
  } else if (stats.rain5d >= crop.wantRain5d) {
    items.push(item('Planting', 'good',
      `About ${r0(stats.rain5d)} mm of rain is forecast over 5 days: good soil moisture for planting.`));
  } else {
    items.push(item('Planting', 'warn',
      `Only ${r0(stats.rain5d)} mm of rain is expected in 5 days. Plant only if you can irrigate.`));
  }

  // Spraying
  if (stats.popMax24 >= 0.4 || stats.rain24 >= 1) {
    items.push(item('Spraying', 'wait',
      `Rain is likely within 24 hours (up to ${r0(stats.popMax24 * 100)}% chance). Products may wash off.`));
  } else if (stats.windMax24 > WIND_LIMIT_MS) {
    items.push(item('Spraying', 'wait',
      `Winds up to ${stats.windMax24.toFixed(1)} m/s will cause spray drift. Spray early morning or later.`));
  } else {
    items.push(item('Spraying', 'good', 'Dry and calm for the next 24 hours: good conditions to spray.'));
  }

  // Fertiliser
  if (stats.rain48 > 30) {
    items.push(item('Fertiliser', 'wait',
      `Heavy rain (${r0(stats.rain48)} mm in 48 h) can wash fertiliser away. Hold off.`));
  } else if (stats.rain48 >= 2) {
    items.push(item('Fertiliser', 'good',
      `Light rain (${r0(stats.rain48)} mm in 48 h) will help nutrients reach the roots.`));
  } else {
    items.push(item('Fertiliser', 'warn',
      'Very dry for 48 hours. Apply only with irrigation, or wait for rain.'));
  }

  // Harvest and drying
  if (stats.popMax48 < 0.3) {
    items.push(item('Harvest & drying', 'good', 'Low rain chance for 48 hours: good window to harvest and dry crops.'));
  } else {
    items.push(item('Harvest & drying', 'wait',
      `Rain chance reaches ${r0(stats.popMax48 * 100)}% within 48 hours. Protect or delay drying.`));
  }

  // Field-work score (higher = easier to work outside)
  let score = 100;
  score -= stats.popMax24 * 40;
  score -= Math.min(stats.rain24, 20) * 1.5;
  score -= Math.max(0, stats.windMax24 - WIND_LIMIT_MS) * 4;
  if (stats.tmax5 > crop.maxTemp) score -= (stats.tmax5 - crop.maxTemp) * 3;
  if (stats.tmin5 < crop.minTemp) score -= (crop.minTemp - stats.tmin5) * 3;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return { score, items };
}

module.exports = { CROPS, computeAdvice, WIND_LIMIT_MS };
