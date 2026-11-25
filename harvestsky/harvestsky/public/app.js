'use strict';

/**
 * HarvestSky - frontend.
 * All API data is written with textContent / DOM APIs (never innerHTML) to prevent XSS.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    crop: $('crop'), country: $('country'), search: $('search'), sortKey: $('sortKey'), sortDir: $('sortDir'),
    units: $('units'), favOnly: $('favOnly'), refresh: $('refresh'), saveNote: $('saveNote'),
    error: $('error'), errorText: $('errorText'), retry: $('retry'), status: $('status'),
    serverName: $('serverName'), grid: $('grid'), shown: $('shown'),
    statBest: $('statBest'), statBestSub: $('statBestSub'), statWet: $('statWet'), statWetSub: $('statWetSub'),
    statWarm: $('statWarm'), statWarmSub: $('statWarmSub'),
    detail: $('detail'), detailTitle: $('detailTitle'), detailSub: $('detailSub'), detailCrop: $('detailCrop'),
    advice: $('advice'), chart: $('chart'), closeDetail: $('closeDetail'),
    guest: $('guest'), member: $('member'), userName: $('userName'), openAuth: $('openAuth'), logout: $('logout'),
    dialog: $('authDialog'), authForm: $('authForm'), authTitle: $('authTitle'), authUser: $('authUser'),
    authPass: $('authPass'), authError: $('authError'), authSubmit: $('authSubmit'), authCancel: $('authCancel'),
    tabLogin: $('tabLogin'), tabSignup: $('tabSignup'), ping: $('ping'), pingResult: $('pingResult'),
  };

  const LOCAL_KEY = 'harvestsky.prefs';
  const state = {
    cities: [], selectedId: null, user: null, loading: false, meta: '', authMode: 'login',
    settings: { units: 'metric', crop: 'maize', favorites: [] },
    sortKey: 'score', sortDir: 'desc',
  };

  /* ---------- small helpers ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs = {}, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const imperial = () => state.settings.units === 'imperial';
  const fmtTemp = (c) => `${Math.round(imperial() ? c * 1.8 + 32 : c)}°`;
  const fmtWind = (ms) => (imperial() ? `${(ms * 2.237).toFixed(0)} mph` : `${(ms * 3.6).toFixed(0)} km/h`);
  const fmtRain = (mm) => (imperial() ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`);
  const pct = (p) => `${Math.round(p * 100)}%`;
  const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function scoreClass(s) {
    if (s >= 70) return 'good';
    if (s >= 40) return 'mid';
    return 'low';
  }

  /* ---------- API ---------- */

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
        cache: 'no-store',
      });
    } catch {
      throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    const server = res.headers.get('X-Served-By');
    if (server) els.serverName.textContent = server;
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (HTTP ${res.status}).`);
    if (!data) throw new Error('The server sent an unreadable response.');
    return data;
  }

  function showError(message) {
    els.errorText.textContent = message;
    els.error.hidden = false;
  }
  const hideError = () => { els.error.hidden = true; };

  /* ---------- settings (account or local) ---------- */

  function loadLocalPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
      if (p.units === 'metric' || p.units === 'imperial') state.settings.units = p.units;
      if (typeof p.crop === 'string') state.settings.crop = p.crop;
    } catch { /* storage unavailable */ }
  }

  let saveTimer = null;
  function persistSettings() {
    if (state.user) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const data = await api('PUT', '/api/settings', state.settings);
          state.settings = data.user.settings;
          flashNote('Settings saved to your account.');
        } catch (err) {
          flashNote(`Could not save settings: ${err.message}`);
        }
      }, 400);
    } else {
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify({ units: state.settings.units, crop: state.settings.crop }));
      } catch { /* ignore */ }
    }
  }

  let noteTimer = null;
  function flashNote(text) {
    els.saveNote.textContent = text;
    els.saveNote.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { els.saveNote.hidden = true; }, 3000);
  }

  function applySettingsToControls() {
    els.units.value = state.settings.units;
    els.crop.value = state.settings.crop;
  }

  function setUser(user) {
    state.user = user;
    els.guest.hidden = !!user;
    els.member.hidden = !user;
    els.favOnly.disabled = !user;
    if (!user) els.favOnly.checked = false;
    if (user) {
      els.userName.textContent = user.username;
      state.settings = user.settings;
    }
    applySettingsToControls();
  }

  /* ---------- data loading ---------- */

  async function loadCities() {
    if (state.loading) return;
    state.loading = true;
    els.refresh.disabled = true;
    els.status.textContent = 'Loading forecasts…';
    hideError();
    try {
      const data = await api('GET', `/api/cities?crop=${encodeURIComponent(state.settings.crop)}`);
      state.cities = data.cities;
      state.meta = `Forecast fetched ${timeFmt.format(new Date(data.fetchedAt))}`;
      if (data.failed) state.meta += ` · ${data.failed} town(s) unavailable`;
      if (data.stale) {
        state.meta += ' · showing last saved data';
        showError('The weather service is not responding. Showing the most recent data we have.');
      }
      fillCountries();
      render();
    } catch (err) {
      showError(err.message);
      els.status.textContent = state.cities.length ? state.meta : 'No forecasts loaded.';
    } finally {
      state.loading = false;
      els.refresh.disabled = false;
    }
  }

  function fillCountries() {
    const current = els.country.value;
    const countries = [...new Set(state.cities.map((c) => c.country))].sort();
    els.country.replaceChildren(el('option', '', 'All countries'), ...countries.map((c) => {
      const o = el('option', '', c);
      o.value = c;
      return o;
    }));
    els.country.firstChild.value = '';
    els.country.value = countries.includes(current) ? current : '';
  }

  /* ---------- rendering ---------- */

  function visibleCities() {
    const term = els.search.value.trim().toLowerCase();
    const country = els.country.value;
    const favs = new Set(state.settings.favorites);
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const value = {
      score: (c) => c.advice.score,
      temp: (c) => c.now.temp,
      rain: (c) => c.stats.popMax24,
      wind: (c) => c.stats.windMax24,
    }[state.sortKey];

    return state.cities
      .filter((c) => (!country || c.country === country)
        && (!term || `${c.name} ${c.country}`.toLowerCase().includes(term))
        && (!els.favOnly.checked || favs.has(c.id)))
      .sort((a, b) => (value ? (value(a) - value(b)) * dir : a.name.localeCompare(b.name) * dir));
  }

  function renderSummary(list) {
    const set = (main, sub, a, b) => { main.textContent = a; sub.textContent = b; };
    if (!list.length) {
      set(els.statBest, els.statBestSub, '–', ''); set(els.statWet, els.statWetSub, '–', ''); set(els.statWarm, els.statWarmSub, '–', '');
      return;
    }
    const best = list.reduce((a, b) => (b.advice.score > a.advice.score ? b : a));
    const wet = list.reduce((a, b) => (b.stats.rain24 > a.stats.rain24 ? b : a));
    const warm = list.reduce((a, b) => (b.now.temp > a.now.temp ? b : a));
    set(els.statBest, els.statBestSub, best.name, `${best.country} · ${best.advice.score}/100`);
    set(els.statWet, els.statWetSub, wet.name, `${wet.country} · ${fmtRain(wet.stats.rain24)} expected`);
    set(els.statWarm, els.statWarmSub, warm.name, `${warm.country} · ${fmtTemp(warm.now.temp)}`);
  }

  function toggleFavourite(id) {
    if (!state.user) {
      openAuth('login');
      return;
    }
    const favs = new Set(state.settings.favorites);
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    state.settings.favorites = [...favs];
    persistSettings();
    render();
  }

  function cityCard(c) {
    const fav = state.settings.favorites.includes(c.id);
    const card = el('article', `city${c.id === state.selectedId ? ' selected' : ''}`);

    const main = el('button', 'city-main');
    main.type = 'button';
    main.setAttribute('aria-label', `Show advice for ${c.name}, ${c.country}`);
    main.addEventListener('click', () => selectCity(c.id));
    main.append(
      el('span', 'city-name', c.name),
      el('span', 'city-country', c.country),
      el('span', 'city-temp', fmtTemp(c.now.temp)),
      el('span', 'city-cond', c.now.description || c.now.condition),
      el('span', 'city-meta', `Rain ${pct(c.stats.popMax24)} · Wind ${fmtWind(c.stats.windMax24)}`),
      el('span', `badge ${scoreClass(c.advice.score)}`, `Field conditions ${c.advice.score}/100`),
    );

    const star = el('button', 'star', fav ? '★' : '☆');
    star.type = 'button';
    star.setAttribute('aria-pressed', String(fav));
    star.setAttribute('aria-label', `${fav ? 'Remove' : 'Add'} ${c.name} ${fav ? 'from' : 'to'} favourites`);
    star.title = state.user ? 'Toggle favourite' : 'Log in to save favourites';
    star.addEventListener('click', () => toggleFavourite(c.id));

    card.append(main, star);
    return card;
  }

  function render() {
    const list = visibleCities();
    renderSummary(list);
    els.shown.textContent = `${list.length} of ${state.cities.length}`;
    els.status.textContent = state.meta;
    els.sortDir.textContent = state.sortDir === 'asc' ? '▲' : '▼';
    if (!list.length) {
      els.grid.replaceChildren(el('p', 'muted', 'No towns match your filters.'));
    } else {
      els.grid.replaceChildren(...list.map(cityCard));
    }
    renderDetail();
  }

  /* ---------- detail panel + chart ---------- */

  function selectCity(id) {
    state.selectedId = id;
    render();
    els.detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderDetail() {
    const c = state.cities.find((x) => x.id === state.selectedId);
    els.detail.hidden = !c;
    if (!c) return;
    const crop = els.crop.options[els.crop.selectedIndex];
    els.detailTitle.textContent = `${c.name}, ${c.country}`;
    els.detailSub.textContent =
      `Now ${fmtTemp(c.now.temp)}, ${c.now.description || c.now.condition} · humidity ${c.now.humidity}% · field conditions ${c.advice.score}/100`;
    els.detailCrop.textContent = crop ? crop.textContent : state.settings.crop;

    const labels = { good: 'Good', warn: 'Caution', wait: 'Wait' };
    els.advice.replaceChildren(...c.advice.items.map((it) => {
      const li = el('li', it.status);
      const head = el('div');
      head.append(el('span', 'task', it.task), el('span', 'verdict', labels[it.status] || it.status));
      li.append(head, el('p', '', it.text));
      return li;
    }));
    renderChart(c);
  }

  function renderChart(c) {
    const W = 520; const H = 250;
    const m = { l: 36, r: 14, t: 30, b: 44 };
    const days = c.days;
    const n = days.length;
    const plotW = W - m.l - m.r;
    const plotH = H - m.t - m.b;
    const temps = days.flatMap((d) => [d.tmin, d.tmax]);
    const lo = Math.floor(Math.min(...temps) - 2);
    const hi = Math.ceil(Math.max(...temps) + 2);
    const maxRain = Math.max(10, ...days.map((d) => d.rain));
    const xAt = (i) => m.l + (plotW / n) * (i + 0.5);
    const yTemp = (t) => m.t + plotH - ((t - lo) / (hi - lo || 1)) * plotH;
    const displayT = (t) => (imperial() ? t * 1.8 + 32 : t);

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'presentation' });

    for (let i = 0; i <= 3; i += 1) {
      const t = lo + ((hi - lo) / 3) * i;
      const y = yTemp(t);
      root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'grid-line' }));
      root.append(svg('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, `${Math.round(displayT(t))}°`));
    }

    days.forEach((d, i) => {
      const bw = Math.min(34, plotW / n - 14);
      const bh = (d.rain / maxRain) * (plotH * 0.55);
      root.append(svg('rect', { x: xAt(i) - bw / 2, y: m.t + plotH - bh, width: bw, height: Math.max(bh, 1), rx: 3, class: 'rain-bar' }));
      const date = new Date(`${d.date}T12:00:00Z`);
      root.append(svg('text', { x: xAt(i), y: H - 24, 'text-anchor': 'middle' },
        date.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })));
      root.append(svg('text', { x: xAt(i), y: H - 10, 'text-anchor': 'middle' }, fmtRain(d.rain)));
    });

    const path = (key) => days.map((d, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yTemp(d[key]).toFixed(1)}`).join(' ');
    root.append(svg('path', { d: path('tmax'), class: 'line-max' }));
    root.append(svg('path', { d: path('tmin'), class: 'line-min' }));
    days.forEach((d, i) => {
      root.append(svg('circle', { cx: xAt(i), cy: yTemp(d.tmax), r: 3.5, class: 'dot-max' }));
      root.append(svg('circle', { cx: xAt(i), cy: yTemp(d.tmin), r: 3.5, class: 'dot-min' }));
      root.append(svg('text', { x: xAt(i), y: yTemp(d.tmax) - 8, 'text-anchor': 'middle', class: 'val' }, fmtTemp(d.tmax)));
      root.append(svg('text', { x: xAt(i), y: yTemp(d.tmin) + 16, 'text-anchor': 'middle', class: 'val' }, fmtTemp(d.tmin)));
    });

    const legend = [['dot-max', 'High'], ['dot-min', 'Low'], ['rain-bar', 'Rain']];
    legend.forEach(([cls, label], i) => {
      const x = m.l + i * 70;
      root.append(svg('rect', { x, y: 6, width: 10, height: 10, rx: 2, class: cls }));
      root.append(svg('text', { x: x + 15, y: 15, class: 'legend-text' }, label));
    });

    els.chart.replaceChildren(root);
  }

  /* ---------- auth dialog ---------- */

  function setAuthMode(mode) {
    state.authMode = mode;
    const login = mode === 'login';
    els.authTitle.textContent = login ? 'Log in' : 'Create an account';
    els.authSubmit.textContent = login ? 'Log in' : 'Sign up';
    els.tabLogin.setAttribute('aria-selected', String(login));
    els.tabSignup.setAttribute('aria-selected', String(!login));
    els.authPass.autocomplete = login ? 'current-password' : 'new-password';
    els.authError.hidden = true;
  }

  function openAuth(mode) {
    setAuthMode(mode);
    els.authForm.reset();
    els.dialog.showModal();
    els.authUser.focus();
  }

  els.authForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    els.authSubmit.disabled = true;
    els.authError.hidden = true;
    try {
      const path = state.authMode === 'login' ? '/api/login' : '/api/register';
      const data = await api('POST', path, { username: els.authUser.value, password: els.authPass.value });
      els.dialog.close();
      setUser(data.user);
      flashNote(`Welcome, ${data.user.username}! Your settings are saved to your account.`);
      loadCities();
    } catch (err) {
      els.authError.textContent = err.message;
      els.authError.hidden = false;
    } finally {
      els.authSubmit.disabled = false;
    }
  });

  els.tabLogin.addEventListener('click', () => setAuthMode('login'));
  els.tabSignup.addEventListener('click', () => setAuthMode('signup'));
  els.authCancel.addEventListener('click', () => els.dialog.close());
  els.openAuth.addEventListener('click', () => openAuth('login'));
  els.logout.addEventListener('click', async () => {
    try { await api('POST', '/api/logout', {}); } catch { /* cookie may already be gone */ }
    state.user = null;
    state.settings = { units: state.settings.units, crop: state.settings.crop, favorites: [] };
    setUser(null);
    render();
  });

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

  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  els.crop.addEventListener('change', () => { state.settings.crop = els.crop.value; persistSettings(); loadCities(); });
  els.units.addEventListener('change', () => { state.settings.units = els.units.value; persistSettings(); render(); });
  els.country.addEventListener('change', render);
  els.favOnly.addEventListener('change', render);
  els.search.addEventListener('input', debounce(render, 150));
  els.sortKey.addEventListener('change', () => {
    state.sortKey = els.sortKey.value;
    state.sortDir = state.sortKey === 'name' ? 'asc' : 'desc';
    render();
  });
  els.sortDir.addEventListener('click', () => { state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'; render(); });
  els.refresh.addEventListener('click', loadCities);
  els.retry.addEventListener('click', loadCities);
  els.closeDetail.addEventListener('click', () => { state.selectedId = null; render(); });
  els.ping.addEventListener('click', pingServers);

  /* ---------- start ---------- */

  async function start() {
    loadLocalPrefs();
    try {
      const meta = await api('GET', '/api/meta');
      els.crop.replaceChildren(...meta.crops.map((c) => {
        const o = el('option', '', c.label);
        o.value = c.id;
        return o;
      }));
    } catch (err) {
      showError(err.message);
    }
    try {
      const me = await api('GET', '/api/me');
      setUser(me.user);
    } catch { setUser(null); }
    applySettingsToControls();
    loadCities();
  }
  start();
})();
