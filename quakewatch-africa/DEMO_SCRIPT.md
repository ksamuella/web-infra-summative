# 2-minute demo script

Aim for about 1:45 so you stay safely under the 2:00 limit. Record your screen with voice-over (OBS, Loom, or your phone's screen recorder). Rehearse once first.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:10 | Browser at `http://localhost:3000` | "This is QuakeWatch Africa, a live earthquake monitor using the USGS API. First, running locally." |
| 0:10–0:25 | Terminal: `npm start`, then the page loads | "One command starts it; no dependencies and no API key needed." |
| 0:25–1:00 | Change region to East Africa; change period to 30 days; drag the magnitude slider; type "Ethiopia" in search; click the Mag and Depth headers | "I can switch regions and time windows, filter by magnitude, search by place and sort any column. The cards and the chart update instantly." |
| 1:00–1:10 | Stop the server or disconnect network; click Refresh | "If the API or network fails, the app shows a clear message and falls back to cached data instead of crashing." *(Optional; skip if short on time.)* |
| 1:10–1:25 | Open `http://LB01_IP/`; point at the "Served by" badge | "Now the deployed version, through the load balancer." |
| 1:25–1:45 | Expand "Load balancer check", press Ping 10×; show the 5/5 split | "Ten requests, five handled by web-01 and five by web-02, so round-robin balancing works." |
| 1:45–1:55 | Terminal on a backend: `sudo systemctl stop quakewatch`; refresh the LB page | "Even with one server down, the site keeps working." *(Optional.)* |

Tips: zoom the browser to 125% so text is readable, close other tabs, and trim any dead time when editing.
