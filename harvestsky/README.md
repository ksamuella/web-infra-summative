# HarvestSky

**Weather-based farm advice for East and Central Africa.** HarvestSky turns the 5-day OpenWeather forecast for 16 farming towns into plain answers to the questions farmers actually ask: *Should I plant, spray, fertilise or harvest this week?* It scores field conditions per town, gives crop-specific advice, and lets signed-in users save their crop, units and favourite towns.

It is deployed on two web servers behind a load balancer, and accounts work on both servers.

| | |
|---|---|
| **Demo video (≤ 2 min)** | `TODO: paste YouTube/Vimeo link` |
| **Live site (load balancer)** | `TODO: http://LB01_IP/` |
| **Web01 / Web02 (direct)** | `TODO: http://WEB01_IP/` · `TODO: http://WEB02_IP/` |
| **Demo login** | `TODO: username / password (create it on the live site, see "Credentials")` |

---

## Why this app

Smallholder farmers across the region plan around rain, but raw forecasts ("60% rain, 4 m/s wind") do not say what to *do*. HarvestSky applies simple agronomy rules (rain before spraying washes products off, heavy rain right after fertiliser causes runoff, wind causes spray drift, and so on) to the forecast for four crops: maize, beans, coffee and Irish potato.

## Features

- **Live forecasts** for 16 towns in Rwanda, Kenya, Uganda, Tanzania, Ethiopia, Burundi, DR Congo and Zambia.
- **Crop advice** for planting, spraying, fertiliser and harvest/drying, plus a 0–100 *field conditions* score per town.
- **Interact with the data:** filter by country, search by town, sort by field conditions / temperature / rain chance / wind / name, favourites-only view, metric or imperial units.
- **Data visualisation:** 5-day chart of daily highs, lows and rainfall (SVG, no libraries) and summary cards (best conditions, wettest, warmest).
- **Accounts and personal settings:** sign up and log in; crop, units and favourite towns are saved to your account and follow you to either server.
- **Error handling:** clear messages when the weather provider is down, the API key is missing or rejected, the rate limit is hit, or the network fails. If the provider fails the server serves the last good (cached) data and says so.
- **Load balancer check:** a panel sends 10 requests and shows how many each backend answered; the header badge shows which server served you.

### Bonus tasks implemented

| Bonus task | What was done |
|---|---|
| Authentication and personal settings | Registration/login, scrypt password hashing, signed HttpOnly session cookies, per-user crop/units/favourites |
| Advanced data visualisation | SVG chart of 5-day temperature range and rainfall, colour-coded scores |
| Performance and caching | 30-minute per-town cache, de-duplication of concurrent requests, stale-data fallback |
| Containers | `Dockerfile` and `docker-compose.yml` that run the whole two-server + load balancer setup locally |
| CI/CD | GitHub Actions: tests, Docker build and smoke test, optional automatic deploy to Web01/Web02 |
| Security | See [Security](#security) (parameterised SQL, input validation, XSS-safe rendering, CSP, CSRF defences, rate limiting, secrets handling) |

---

## Architecture

```
                  ┌──────────────────────┐
   Browser  ────► │ Lb01 (Nginx/HAProxy) │  round-robin, health checks, blocks /internal/
                  └──────────┬───────────┘
                   ┌─────────┴─────────┐
                   ▼                   ▼
        ┌───────────────────┐ ┌───────────────────┐
        │ Web01             │ │ Web02             │
        │ Nginx :80         │ │ Nginx :80         │
        │  └► Node :3000    │ │  └► Node :3000    │
        │     SQLite users  │◄┼─► SQLite users    │   account replication
        └─────────┬─────────┘ └─────────┬─────────┘
                  └──────────┬──────────┘
                             ▼
                OpenWeather 5-day forecast API
```

**How logins work across two servers.** Each server has its own SQLite database. Sessions are *stateless signed cookies* (HMAC-SHA256 with `AUTH_SECRET`, identical on both servers), so either server accepts a cookie issued by the other. When a user registers or changes settings, the server immediately pushes the record to its peer (`POST /internal/sync`, authenticated with `SYNC_SECRET`), and every 30 seconds each server also pulls from its peer to catch up after a restart. Conflicts are resolved by last write wins. The `/internal/` path is blocked at the load balancer and restricted to the peer's IP in Nginx.

---

## API used and credits

- **OpenWeather 5 day / 3 hour forecast API**: <https://openweathermap.org/forecast5>. Thank you to OpenWeather. API key management: <https://home.openweathermap.org/api_keys>. Terms: <https://openweathermap.org/terms>.
- Built with plain Node.js (built-ins `http`, `crypto`, `node:sqlite`, `fetch`) and plain HTML/CSS/JavaScript. **No third-party packages.**

The API key is read from the `OPENWEATHER_API_KEY` environment variable on the server. The browser never sees it: the frontend calls this app's own `/api/cities` endpoint, and the server calls OpenWeather.

### Getting an OpenWeather key

1. Sign up at <https://home.openweathermap.org/users/sign_up> (free plan).
2. Copy the key from <https://home.openweathermap.org/api_keys>.
3. **New keys can take up to 2 hours to activate.** Until then the app shows "The weather API key was rejected."

---

## Run locally

Requires **Node.js 22.13 or newer** (`node --version`). It uses the built-in SQLite module, so there is nothing to `npm install`.

```bash
git clone https://github.com/TODO_USERNAME/harvestsky.git
cd harvestsky
cp .env.example .env
# edit .env: set OPENWEATHER_API_KEY, AUTH_SECRET and SYNC_SECRET
#   openssl rand -hex 32     -> AUTH_SECRET
#   openssl rand -hex 24     -> SYNC_SECRET
npm start
```

Open <http://localhost:3000>. Run the automated tests (no network or API key needed):

```bash
npm test
```

### Run the full two-server setup with Docker

```bash
cp .env.example .env     # fill in the three values
docker compose up --build
```

Open <http://localhost:8080>, expand **Load balancer check** and press **Ping 10×**: requests alternate between `web-01` and `web-02`. Register an account and log in: it works on both.

### Configuration

| Variable | Purpose | Default |
|---|---|---|
| `OPENWEATHER_API_KEY` | OpenWeather key (server side only) | none (required) |
| `AUTH_SECRET` | Signs session cookies; **same on every server**; ≥ 32 chars (required in production) | random per start (dev only) |
| `SYNC_SECRET` | Authenticates server-to-server replication; same on every server; ≥ 16 chars | none |
| `PEERS` | Other web server(s), e.g. `http://10.0.0.12` (set by `deploy.sh`) | none |
| `SERVER_NAME` | Name in the "Served by" badge (`web-01`, `web-02`) | hostname |
| `PORT`, `HOST` | Listen address | `3000`, `0.0.0.0` |
| `DB_PATH` | SQLite file | `./data/harvestsky.db` |
| `CACHE_TTL_SECONDS` | Forecast cache lifetime | `1800` |
| `TRUST_PROXY` | Use `X-Real-IP` from the reverse proxy (set to `1` behind Nginx) | off |

---

## Deployment on Web01, Web02 and Lb01

### 1. Prepare Web01 and Web02 (once per server)

```bash
sudo apt update
sudo apt install -y nginx rsync curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version        # must be v22.13 or newer
```

### 2. Create the production secrets file (on your laptop)

Create `.env.production` in the project folder. It is git-ignored and is **never committed**:

```
OPENWEATHER_API_KEY=your-openweather-key
AUTH_SECRET=<output of: openssl rand -hex 32>
SYNC_SECRET=<output of: openssl rand -hex 24>
```

### 3. Deploy

```bash
LB_IP=<Lb01 address> ./deploy/deploy.sh ubuntu@WEB01_IP ubuntu@WEB02_IP
```

Use IP addresses that both web servers can reach each other on. For each server the script:

1. Copies the code to `/opt/harvestsky` (without `.git`, `node_modules`, `.env*` or tests).
2. Writes the secrets plus `SERVER_NAME` and `PEERS` to `/etc/harvestsky.env` (`root:root`, mode `600`).
3. Installs the Nginx site (`deploy/nginx-web.conf`), which proxies port 80 to Node on `127.0.0.1:3000`, trusts the visitor IP forwarded by Lb01, and lets only the other web server call `/internal/`.
4. Installs and starts the systemd service `harvestsky` (runs as `www-data`, restarts on failure).
5. Calls `/health` to confirm the app is up.

Verify each server directly:

```bash
curl http://WEB01_IP/health    # {"status":"ok","server":"web-01",...}
curl http://WEB02_IP/health    # {"status":"ok","server":"web-02",...}
```

### 4. Configure the load balancer (Lb01)

Choose **one** option and replace `WEB01_IP` / `WEB02_IP` in the file first.

**Option A: Nginx** (`deploy/nginx-lb.conf`)

```bash
sudo apt install -y nginx
sudo cp nginx-lb.conf /etc/nginx/sites-available/harvestsky-lb
sudo ln -sf /etc/nginx/sites-available/harvestsky-lb /etc/nginx/sites-enabled/harvestsky-lb
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

**Option B: HAProxy** (`deploy/haproxy.cfg`)

```bash
sudo apt install -y haproxy
sudo sh -c 'cat haproxy.cfg >> /etc/haproxy/haproxy.cfg'
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
sudo systemctl restart haproxy
```

**How it works.** Both use round-robin, so requests alternate between Web01 and Web02. The load balancer passes the original `Host` header and the visitor IP (`X-Real-IP`), returns 404 for `/internal/` so account replication is never exposed, and removes an unhealthy server from rotation (Nginx: `max_fails` and retry on the other upstream; HAProxy: active `GET /health` checks every 5 s).

### 5. Test the load balancer

```bash
for i in $(seq 1 10); do curl -s http://LB01_IP/api/whoami; echo; done
```

The output alternates `"server":"web-01"` and `"server":"web-02"`. In the browser, expand **Load balancer check** and press **Ping 10×** (expect 5/5).

**Accounts across servers:** register on the live site, then run the loop above while logged in. `/api/me` returns your user whichever server answers.

**Failover test:** `sudo systemctl stop harvestsky` on Web01 and repeat: every response now comes from `web-02` with no errors. Start it again and traffic returns to both. (On start, Web01 pulls any accounts it missed from Web02.)

---

## CI/CD (GitHub Actions)

`.github/workflows/ci.yml` runs on every push and pull request:

1. **test:** `npm test` on Node 22.
2. **docker:** builds the image and checks that the container answers `/health`.
3. **deploy** (push to `main` only, **off by default**): runs `deploy/deploy.sh` against Web01/Web02, then calls the load balancer six times to confirm both servers answer.

To enable automatic deployment, in *Settings → Secrets and variables → Actions* add the variable `ENABLE_DEPLOY` = `true` and the secrets `SSH_PRIVATE_KEY`, `SSH_USER`, `WEB01_HOST`, `WEB02_HOST`, `LB_HOST`, `OPENWEATHER_API_KEY`, `AUTH_SECRET` and `SYNC_SECRET`. The servers must be reachable from GitHub's runners; if they are only reachable from your school network, deploy from your laptop instead.

---

## Security

- **Secrets:** the API key and signing secrets exist only in environment variables (`.env` locally, `/etc/harvestsky.env` mode 600 on servers). `.env*` is git-ignored; only `.env.example` (no values) is committed. The key is never sent to the browser or written to logs.
- **Passwords:** hashed with scrypt (random 16-byte salt per user), compared in constant time; login does not reveal whether a username exists.
- **Sessions:** HMAC-signed, expiring, `HttpOnly`, `SameSite=Strict` cookies.
- **SQL injection:** every query uses prepared statements with bound parameters; usernames are also restricted to `[a-z0-9_]`. Covered by tests with injection payloads.
- **XSS:** the frontend builds the page with DOM APIs and `textContent` only (no `innerHTML`); a strict Content-Security-Policy (`script-src 'self'`) is sent on every response.
- **CSRF:** state-changing endpoints require `Content-Type: application/json` and reject cross-origin `Origin` headers, on top of `SameSite=Strict` cookies.
- **Input validation:** whitelist validation for crops, units, towns, usernames, passwords and replicated records; request bodies are size-limited.
- **Abuse protection:** per-IP rate limits (general API and a stricter limit on login/registration); path-traversal protection on static files; only `GET`/`HEAD` on static routes.
- **Server-to-server channel:** `/internal/` requires a shared secret (constant-time check), is blocked at the load balancer and is IP-restricted in Nginx.
- **Process hardening:** systemd runs the app as `www-data` with `NoNewPrivileges`, `ProtectSystem`, `ProtectHome` and `PrivateTmp`.

## Project structure

```
server.js             HTTP server, routing, security headers, config
lib/                  auth, db (SQLite), weather (OpenWeather + cache), advice (rules),
                      sync (replication), validate, ratelimit, cities
public/               Frontend: index.html, style.css, app.js
test/                 Unit and integration tests (28), including a two-server replication test
deploy/               systemd unit, Nginx and HAProxy configs, deploy.sh
Dockerfile, docker-compose.yml   Containers (bonus)
.github/workflows/    CI/CD (bonus)
```

## Credentials for markers

- **OpenWeather API key:** `TODO: paste the key in the submission comment box (never in this README or in Git).`
- **Application login:** `TODO: username / password`. Create it once on the live site with **Log in / Sign up → Sign up**; it works on both servers.

## Challenges and how they were handled

> **Rewrite this section with your own experience before submitting.** These are real design problems in this project, so you can explain them in your own words:

- **Logins behind a load balancer.** With round-robin, a user could register on Web01 and have the next request land on Web02, which has never heard of them. Solved with stateless signed session cookies (shared secret) plus replication of accounts between the two servers.
- **API key safety.** The key must be usable by the app but never exposed. Solved with a server-side proxy and environment variables, with the key never sent to the client or committed.
- **Provider outages and rate limits.** A 16-town dashboard makes 16 API calls per refresh. Solved with a per-town cache, de-duplication of in-flight requests, and a stale-data fallback that is clearly labelled in the UI.
- **Spoofable client IPs.** Rate limiting needs the real visitor IP, but `X-Forwarded-For` can be faked. Solved by trusting `X-Real-IP` only when it comes from the load balancer (`set_real_ip_from`).

## Licence

MIT
