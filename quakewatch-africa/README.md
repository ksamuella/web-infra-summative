# QuakeWatch Africa

A live earthquake monitor for Africa and the East African Rift, built on the public **USGS Earthquake Catalog API**. Users can explore recent seismic activity by region and time window, filter by magnitude, search by place name, and sort every column. The app is deployed on two web servers behind a load balancer, and it can show you which server answered each request.

> **Why this app?** The East African Rift is one of the most seismically active zones on Earth, yet accessible, plain-language monitoring tools for African regions are rare. QuakeWatch gives students, journalists and curious residents a fast way to see what is happening.

| | |
|---|---|
| **Demo video (≤ 2 min)** | `TODO: paste YouTube/Vimeo link` |
| **Live site (load balancer)** | `TODO: http://LB01_IP/` |
| **Web01 / Web02 (direct)** | `TODO: http://WEB01_IP/` · `TODO: http://WEB02_IP/` |

---

## Features

- **Live data** from the USGS FDSN Event API for four regions: All Africa, East Africa & Rift Valley, North Africa, Southern Africa.
- **Time windows:** past 24 hours, 7 days or 30 days.
- **Interact with the data:** magnitude slider, place search, sortable columns (time, magnitude, depth, location).
- **Summary cards:** event count, strongest event, average depth, most recent event.
- **Magnitude distribution chart** that updates with your filters.
- **Graceful error handling:** clear messages when USGS or the network is down; the server falls back to the last good (cached) data when USGS is unreachable.
- **Load balancer check:** a built-in panel sends 10 requests and shows how many each backend served. The header badge always shows the current server.
- **Accessible and responsive:** keyboard-friendly, ARIA labels, dark mode, mobile layout.

### Bonus tasks implemented

| Bonus | What was done |
|---|---|
| Caching | Server-side in-memory cache (TTL 120 s) with stale-data fallback |
| Security | Strict input validation (allow-lists), Content-Security-Policy, XSS-safe rendering (`textContent` only), path-traversal protection, rate limiting, URL allow-listing |
| Data visualisation | Magnitude histogram |
| Docker | `Dockerfile` with health check |
| CI | GitHub Actions workflow runs the tests on every push |

---

## Architecture

```
                 ┌────────────────────┐
   Browser ────► │  Lb01 (Nginx or    │   round-robin + health checks
                 │  HAProxy, port 80) │
                 └─────────┬──────────┘
                  ┌────────┴─────────┐
                  ▼                  ▼
        ┌──────────────────┐ ┌──────────────────┐
        │ Web01            │ │ Web02            │
        │ Nginx :80        │ │ Nginx :80        │
        │  └► Node :3000   │ │  └► Node :3000   │
        └────────┬─────────┘ └────────┬─────────┘
                 └─────────┬──────────┘
                           ▼
              USGS Earthquake Catalog API
```

Each web server runs the same Node.js app (managed by systemd) behind a local Nginx reverse proxy. The app tags every response with `X-Served-By: web-01|web-02`, and `/health` is used for load-balancer health checks.

---

## API used and credits

- **USGS Earthquake Catalog (FDSN Event Web Service)** – <https://earthquake.usgs.gov/fdsnws/event/1/>
  Data from the U.S. Geological Survey, which is in the public domain (<https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits>). Thank you to the USGS Earthquake Hazards Program.
- The API requires **no API key**, so this project contains no secrets. Please see the submission note below.
- No external libraries: the app uses only Node.js built-ins (`http`, `fs`, `path`, `os`, global `fetch`).

---

## Run locally

Requires **Node.js 18 or newer** (tested on 22).

```bash
git clone https://github.com/TODO_USERNAME/quakewatch-africa.git
cd quakewatch-africa
cp .env.example .env      # optional; defaults work without it
npm start
```

Open <http://localhost:3000>. To change settings, export the variables from `.env.example` before `npm start` (for example `PORT=8080 npm start`).

Run the tests (no network needed):

```bash
npm test
```

With Docker:

```bash
docker build -t quakewatch .
docker run -p 3000:3000 -e SERVER_NAME=docker quakewatch
```

---

## Deployment

### 1. Prepare Web01 and Web02 (once per server)

SSH into each server and install Nginx, rsync and Node.js (18+):

```bash
sudo apt update
sudo apt install -y nginx rsync curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version      # should print v18 or newer
```

### 2. Deploy the app

From your laptop (replace the addresses/users with yours):

```bash
./deploy/deploy.sh ubuntu@WEB01_IP ubuntu@WEB02_IP
```

The script, for each server:

1. Uploads the code to `/opt/quakewatch` (without `.git`, `node_modules` or `.env`).
2. Writes `SERVER_NAME=web-01` (or `web-02`) to `/etc/quakewatch.env`.
3. Installs the systemd unit (`deploy/quakewatch.service`) and starts the Node app on `127.0.0.1:3000`.
4. Installs the Nginx site (`deploy/nginx-web.conf`), which proxies port 80 to the app, then reloads Nginx.
5. Calls `/health` to confirm the app is up.

Verify each server directly:

```bash
curl http://WEB01_IP/health     # {"status":"ok","server":"web-01",...}
curl http://WEB02_IP/health     # {"status":"ok","server":"web-02",...}
```

### 3. Configure the load balancer (Lb01)

Pick **one** of the two options. Replace `WEB01_IP` / `WEB02_IP` in the file first.

**Option A – Nginx** (`deploy/nginx-lb.conf`)

```bash
sudo apt install -y nginx
sudo cp nginx-lb.conf /etc/nginx/sites-available/quakewatch-lb
sudo ln -sf /etc/nginx/sites-available/quakewatch-lb /etc/nginx/sites-enabled/quakewatch-lb
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

**Option B – HAProxy** (`deploy/haproxy.cfg`)

```bash
sudo apt install -y haproxy
sudo sh -c 'cat haproxy.cfg >> /etc/haproxy/haproxy.cfg'
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
sudo systemctl restart haproxy
```

**How it works.** Both options use round-robin, so requests alternate between Web01 and Web02. They forward the original client address (`X-Forwarded-For`) and the `Host` header. Nginx retries a failed request on the other server (`proxy_next_upstream`) and temporarily removes a failing server (`max_fails`); HAProxy actively probes `GET /health` every 5 s and removes a server after 3 failed checks.

### 4. Test the load balancer

Send 10 requests and look at which server answers:

```bash
for i in $(seq 1 10); do curl -s http://LB01_IP/api/whoami; echo; done
```

Expected output alternates `"server":"web-01"` and `"server":"web-02"`. You can also open the site, expand **Load balancer check** at the bottom and press **Ping 10×**.

Failover test: stop one backend (`sudo systemctl stop quakewatch` on Web01), repeat the loop, and confirm every response now comes from `web-02` with no errors. Then start it again and watch traffic return to both servers.

---

## Project structure

```
server.js            Node server: static files, USGS proxy, cache, validation, health
public/              Frontend (index.html, style.css, app.js)
test/                Automated tests (node:test)
deploy/              systemd unit, Nginx/HAProxy configs, deploy script
Dockerfile           Container image (bonus)
.github/workflows/   CI pipeline (bonus)
```

## Security notes

- No secrets are stored or required. `.gitignore` excludes `.env`, keys and `node_modules`.
- The browser never calls USGS directly; only the server does, so the frontend's Content-Security-Policy can restrict everything to `'self'`.
- Query parameters are checked against allow-lists; API data is rendered with `textContent`; links from the API are only accepted if they point to `https://earthquake.usgs.gov/`.
- Static file serving rejects path traversal. API routes are rate limited.

## Challenges and how they were handled

> **Edit this section with your own experience before submitting.** Suggested starting points that reflect real design decisions in this project:

- **USGS availability and speed:** a 30-day query can be slow. Solved with a short-lived server cache and by serving the last good data (flagged as stale in the UI) if USGS fails.
- **Showing that load balancing works:** the app is identical on both servers, so it is hard to see which one answered. Solved with an `X-Served-By` header, a `/api/whoami` endpoint and the in-app "Load balancer check" panel.
- **Keeping the frontend safe:** earthquake place names come from a third party. Solved by rendering with `textContent`, a strict CSP and URL allow-listing.

## Credits

- Earthquake data: [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/).
- Built with plain HTML, CSS, JavaScript and Node.js; no third-party packages.

## Licence

MIT
