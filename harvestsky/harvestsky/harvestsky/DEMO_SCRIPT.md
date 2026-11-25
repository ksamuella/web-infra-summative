# 2-minute demo script

Aim for about 1:45 so you stay safely under 2:00. Record the screen with voice-over (OBS, Loom, or your phone's screen recorder) and rehearse once. Zoom the browser to 125% so text is readable.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:10 | Terminal, then browser at `http://localhost:3000` | "This is HarvestSky: weather-based farm advice for East Africa using the OpenWeather API. First, running locally." |
| 0:10–0:20 | Terminal: `npm start`; page loads with the town cards | "One command starts it. The API key stays on the server in a `.env` file, never in the browser or in Git." |
| 0:20–0:55 | Choose a crop; filter by Rwanda; search "Mus"; sort by rain chance; click a town; point at the advice and the 5-day chart | "I pick a crop, filter by country, search and sort by conditions. Clicking a town shows advice for planting, spraying, fertiliser and harvest, and a five-day chart of temperature and rain." |
| 0:55–1:10 | Sign up; star two towns; switch to imperial; log out and back in | "Accounts save my crop, units and favourite towns. Passwords are hashed and sessions are signed." |
| 1:10–1:20 | Disconnect network or stop mock; press Refresh *(optional)* | "If the weather service fails, I get a clear message and the last saved data instead of a crash." |
| 1:20–1:35 | Open `http://LB01_IP/`; point at the "Served by" badge | "Now the deployed version through the load balancer." |
| 1:35–1:50 | Expand **Load balancer check**, press Ping 10×; show 5/5 split; refresh while logged in | "Ten requests: five from web-01, five from web-02. My login works on both servers because accounts are replicated." |
| 1:50–1:58 | Terminal: `sudo systemctl stop harvestsky` on one web server; reload the page *(optional)* | "Even with one server down, the site keeps working." |

Tips: trim dead time when editing, keep the cursor slow and deliberate, and do a full dry run on the live site before recording so the cache is warm.
