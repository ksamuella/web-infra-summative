'use strict';

/**
 * QuakeWatch Africa - frontend.
 * All user/API data is written with textContent (never innerHTML) to avoid XSS.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    region: $('region'), period: $('period'), minMag: $('minMag'), minMagOut: $('minMagOut'),
    search: $('search'), refresh: $('refresh'), autoRefresh: $('autoRefresh'),
    error: $('error'), errorText: $('errorText'), retry: $('retry'), status: $('status'),
    serverName: $('serverName'), rows: $('rows'), shown: $('shown'), histogram: $('histogram'),
    statCount: $('statCount'), statMax: $('statMax'), statMaxPlace: $('statMaxPlace'),
    statDepth: $('statDepth'), statLatest: $('statLatest'), statLatestPlace: $('statLatestPlace'),
    ping: $('ping'), pingResult: $('pingResult'),
  };

  const PREF_KEY = 'quakewatch.prefs';
  const AUTO_REFRESH_MS = 60000;
  const state = { quakes: [], sortKey: 'time', sortDir: 'desc', loading: false, meta: '' };

  /* ---------- preferences (best effort; storage may be unavailable) ---------- */

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (p.region) els.region.value = p.region;
      if (p.period) els.period.value = p.period;
      if (typeof p.minMag === 'number') els.minMag.value = String(p.minMag);
    } catch { /* ignore */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        region: els.region.value, period: els.period.value, minMag: Number(els.minMag.value),
      }));
    } catch { /* ignore */ }
  }

  /* ---------- formatting ---------- */

  const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function relTime(ms) {
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  function magClass(m) {
    if (m >= 6) return 'mag-severe';
    if (m >= 5) return 'mag-high';
    if (m >= 4) return 'mag-mid';
    return 'mag-low';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------- messages ---------- */

  function showError(message) {
    els.errorText.textContent = message;
    els.error.hidden = false;
  }

  function hideError() { els.error.hidden = true; }

  function setServer(name) { if (name) els.serverName.textContent = name; }

  /* ---------- data loading ---------- */

  async function fetchJson(url) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    } catch {
      throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    setServer(res.headers.get('X-Served-By'));
    if (!res.ok) throw new Error((data && data.error) || `Request failed (HTTP ${res.status}).`);
    if (!data) throw new Error('The server returned an unreadable response.');
    return data;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    els.refresh.disabled = true;
    els.status.textContent = 'Loading earthquakes…';
    hideError();
    try {
      const q = `region=${encodeURIComponent(els.region.value)}&period=${encodeURIComponent(els.period.value)}`;
      const data = await fetchJson(`/api/quakes?${q}`);
      state.quakes = Array.isArray(data.quakes) ? data.quakes : [];
      const when = timeFmt.format(new Date(data.fetchedAt));
      state.meta = `Data fetched ${when}`;
      if (data.stale) state.meta += ' · USGS unreachable, showing last saved data';
      else if (data.cached) state.meta += ' · from server cache';
      if (data.stale) showError('USGS is not responding. Showing the most recent data we have.');
      render();
    } catch (err) {
      showError(err.message);
      els.status.textContent = state.quakes.length ? state.meta : 'No data loaded.';
    } finally {
      state.loading = false;
      els.refresh.disabled = false;
    }
  }

  /* ---------- rendering ---------- */

  function visibleQuakes() {
    const min = Number(els.minMag.value);
    const term = els.search.value.trim().toLowerCase();
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const key = state.sortKey;
    return state.quakes
      .filter((q) => q.mag >= min && (!term || q.place.toLowerCase().includes(term)))
      .sort((a, b) => {
        if (key === 'place') return a.place.localeCompare(b.place) * dir;
        const av = a[key] ?? -Infinity;
        const bv = b[key] ?? -Infinity;
        return (av - bv) * dir;
      });
  }

  function renderStats(list) {
    els.statCount.textContent = String(list.length);
    if (!list.length) {
      els.statMax.textContent = '–'; els.statMaxPlace.textContent = '';
      els.statDepth.textContent = '–'; els.statLatest.textContent = '–'; els.statLatestPlace.textContent = '';
      return;
    }
    const strongest = list.reduce((a, b) => (b.mag > a.mag ? b : a));
    const latest = list.reduce((a, b) => (b.time > a.time ? b : a));
    const depths = list.filter((q) => q.depth !== null).map((q) => q.depth);
    els.statMax.textContent = `M ${strongest.mag.toFixed(1)}`;
    els.statMaxPlace.textContent = strongest.place;
    els.statDepth.textContent = depths.length
      ? `${(depths.reduce((s, d) => s + d, 0) / depths.length).toFixed(0)} km` : '–';
    els.statLatest.textContent = relTime(latest.time);
    els.statLatestPlace.textContent = latest.place;
  }

  function renderHistogram(list) {
    const buckets = [
      { label: '<2', test: (m) => m < 2, cls: 'mag-low' },
      { label: '2–3', test: (m) => m >= 2 && m < 3, cls: 'mag-low' },
      { label: '3–4', test: (m) => m >= 3 && m < 4, cls: 'mag-low' },
      { label: '4–5', test: (m) => m >= 4 && m < 5, cls: 'mag-mid' },
      { label: '5–6', test: (m) => m >= 5 && m < 6, cls: 'mag-high' },
      { label: '6+', test: (m) => m >= 6, cls: 'mag-severe' },
    ].map((b) => ({ ...b, count: list.filter((q) => b.test(q.mag)).length }));
    const max = Math.max(1, ...buckets.map((b) => b.count));

    els.histogram.replaceChildren(...buckets.map((b) => {
      const col = el('div', 'bar-col');
      col.append(el('span', 'bar-count', String(b.count)));
      const bar = el('div', `bar ${b.cls}`);
      bar.style.height = `${Math.round((b.count / max) * 100)}px`;
      col.append(bar, el('span', 'bar-label', b.label));
      return col;
    }));
  }

  function renderRows(list) {
    if (!list.length) {
      const tr = el('tr');
      const td = el('td', 'empty', 'No earthquakes match your filters.');
      td.colSpan = 4;
      tr.append(td);
      els.rows.replaceChildren(tr);
      return;
    }
    els.rows.replaceChildren(...list.slice(0, 300).map((q) => {
      const tr = el('tr');
      const time = el('td', 'time', timeFmt.format(new Date(q.time)));
      time.append(el('small', '', relTime(q.time)));
      const mag = el('td');
      mag.append(el('span', `mag ${magClass(q.mag)}`, q.mag.toFixed(1)));
      const depth = el('td', '', q.depth === null ? '–' : `${q.depth.toFixed(0)} km`);
      const place = el('td');
      if (q.url) {
        const a = el('a', '', q.place);
        a.href = q.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        place.append(a);
      } else {
        place.append(document.createTextNode(q.place));
      }
      if (q.tsunami) place.append(el('span', 'tsunami', 'tsunami flag'));
      tr.append(time, mag, depth, place);
      return tr;
    }));
  }

  function render() {
    const list = visibleQuakes();
    renderStats(list);
    renderHistogram(list);
    renderRows(list);
    const capped = list.length > 300 ? ' (first 300 shown)' : '';
    els.shown.textContent = `${list.length} of ${state.quakes.length}${capped}`;
    els.status.textContent = state.meta;
    document.querySelectorAll('th[aria-sort]').forEach((th) => th.removeAttribute('aria-sort'));
    const active = document.querySelector(`th button[data-sort="${state.sortKey}"]`);
    if (active) active.parentElement.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending');
  }

  /* ---------- load balancer check ---------- */

  async function pingServers() {
    els.ping.disabled = true;
    const tally = {};
    let failed = 0;
    for (let i = 0; i < 10; i += 1) {
      try {
        const res = await fetch(`/api/whoami?t=${Date.now()}-${i}`, { cache: 'no-store' });
        const data = await res.json();
        tally[data.server] = (tally[data.server] || 0) + 1;
      } catch { failed += 1; }
    }
    const rows = Object.entries(tally).sort().map(([name, n]) => {
      const li = el('li', '', `${name}: ${n}/10`);
      const bar = el('span', 'ping-bar');
      bar.style.width = `${n * 12}px`;
      li.append(bar);
      return li;
    });
    if (failed) rows.push(el('li', '', `${failed} request(s) failed`));
    els.pingResult.replaceChildren(...rows);
    els.ping.disabled = false;
  }

  /* ---------- events ---------- */

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  els.region.addEventListener('change', () => { savePrefs(); load(); });
  els.period.addEventListener('change', () => { savePrefs(); load(); });
  els.minMag.addEventListener('input', () => {
    els.minMagOut.textContent = Number(els.minMag.value).toFixed(1);
    savePrefs();
    render();
  });
  els.search.addEventListener('input', debounce(render, 150));
  els.refresh.addEventListener('click', load);
  els.retry.addEventListener('click', load);
  els.ping.addEventListener('click', pingServers);

  document.querySelectorAll('th button[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = key === 'place' ? 'asc' : 'desc';
      }
      render();
    });
  });

  setInterval(() => {
    if (els.autoRefresh.checked && !document.hidden) load();
  }, AUTO_REFRESH_MS);

  loadPrefs();
  els.minMagOut.textContent = Number(els.minMag.value).toFixed(1);
  load();
})();
