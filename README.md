# LIMITLESS — Tournament-ready: permanent results only (GitHub + Render Free + Excel)

**You do not need to rewrite your website in Python.** This release preserves the existing HTML/CSS/JavaScript Admin + Player dashboards and runs their existing Python API on Render.

The critical change is that every successful event-state change is stored in an `.xlsx` workbook **in your separate PRIVATE GitHub data repository**, instead of depending on Render's temporary filesystem. Players' battle-ID messages remain **in server RAM only**, never in Excel, and are lost after a server restart or when their battle ends. **When the admin concludes a tournament, only its name, date, champion, runner-up and each participant's final position are archived; finished match pairings, team submissions and check-in details are removed.**

## Fast setup for the tournament

### 1. Create a GitHub repository for your WEBSITE

1. Go to <https://github.com/new> and name the repository `limitless` (public or private).
2. Extract the downloaded ZIP. Open the extracted `limitless` folder.
3. Upload the **contents of that folder** to the root of your new GitHub repository using **Add file → Upload files → Commit changes**.
4. You must see `server.py`, `github_excel.py`, `requirements.txt`, `public/`, and this `README.md` at the **repository root**, not buried inside a second folder.

### 2. Create a SEPARATE private GitHub repository for the Excel database

1. Go to <https://github.com/new> again.
2. Name it `limitless-data` and set **Private**.
3. Select **Add a README file** (this creates the `main` branch), then **Create repository**.
4. Write down the full repository name, for example `YOUR-GITHUB-USERNAME/limitless-data`.

**Why separate?** Saving a score/player to Excel creates a GitHub commit. Keeping Excel in a different repository stops each save from triggering Render to redeploy your website and disconnect chats.

### 3. Create a GitHub fine-grained token for ONLY the private Excel repository

1. Open <https://github.com/settings/personal-access-tokens/new>.
2. Token name: `limitless-excel`.
3. Resource owner: the GitHub account that owns `limitless-data`.
4. **Repository access → Only select repositories → limitless-data.**
5. **Repository permissions → Contents → Read and write**. (Metadata Read is automatic.)
6. Choose an expiration **after the tournament** and generate the token.
7. Copy the token now. **DO NOT upload it to GitHub, put it in a JS file, paste it into chat, or share it with players.**

If the token expires later, create a replacement and update the `GITHUB_TOKEN` value on Render. Without a valid token the site cannot save new registrations. The code intentionally fails rather than pretending to save.

### 4. Create one FREE Render Python web service

1. Open <https://dashboard.render.com/> and sign up or sign in using GitHub. The Free web service plan does not require a credit card according to Render's published free-tier documentation, but eligibility and quotas are controlled by Render.
2. **New → Web Service → Build and deploy from a Git repository**.
3. Connect the **`limitless` website repository**, NOT `limitless-data`.
4. Set:

   | Render field | Enter |
   |---|---|
   | Name | `limitless-tournament` (or another available name) |
   | Language/Runtime | **Python 3** (NOT Static Site) |
   | Branch | `main` |
   | Root Directory | *leave blank* |
   | Build Command | `pip install -r requirements.txt` |
   | Start Command | `python server.py` |
   | Instance Type | **Free** |

5. In **Environment**, add the exact variables below, with your own values. Render already supplies `PORT`.

   | Environment variable | Value |
   |---|---|
   | `GITHUB_DATA_REPO` | `YOUR-GITHUB-USERNAME/limitless-data` |
   | `GITHUB_TOKEN` | Fine-grained token copied in Step 3 |
   | `GITHUB_DATA_BRANCH` | `main` |
   | `ADMIN_USER` | `admin` |
   | `ADMIN_PASSWORD` | Your own strong password (do not use `admin` as password) |
   | `SESSION_SECRET` | A *separate* long random secret (at least 32 characters); keep the same value after redeploys |

6. Click **Deploy Web Service**. Look at the **Logs** tab until the deploy is live. The server will **automatically create `limitless.xlsx`** in the private `limitless-data` repository.

   - **Do not add a Render disk/volume.** Render Free does not support persistent disks.
   - **Do not deploy the data repository.** It contains data only, not code.
   - **Do not enable extra workers or multiple separate instances.** This version expects one backend.

### 5. Get your LIVE website links

Render gives you a domain resembling `https://limitless-tournament.onrender.com` (your real URL may differ).

| Feature | Address |
|---|---|
| Player sign-up & dashboard | `https://YOUR-SERVICE.onrender.com/player/` |
| Admin login & tournament controls | `https://YOUR-SERVICE.onrender.com/admin/` |
| Connectivity / backend check | `https://YOUR-SERVICE.onrender.com/api/health` |

`/api/health` should show `"storage":"github-excel"` when your Github data sync is correctly configured. The private GitHub `limitless-data` repository should now show `limitless.xlsx`. After registering a test player, refresh that repository and confirm `limitless.xlsx` has a new commit.

### 6. TEST before sharing tomorrow

1. Open `/admin/` and log in with `ADMIN_USER` and `ADMIN_PASSWORD`.
2. Open `/player/` on two separate browsers/phones; register **two DIFFERENT users**.
3. Confirm both appear in Admin and can join a tournament.
4. Start the tournament, create the first pairing/round.
5. Send a test battle ID in one player's match chat and check that the other player sees it.
6. Confirm **Download Excel** in Admin works and battle-ID chat is **not present** in the workbook.
7. Restart/redeploy the Render service, wait for it to become live, and verify the player accounts and tournament are still available. **Chat is intentionally erased when the backend restarts.**
8. **Start the website 5–10 minutes before the event** by opening the admin/player URLs. Free Render services can sleep after 15 idle minutes and the first new request may need up to about a minute to wake them.

## Exactly what stays in Excel

### Forever: completed tournament records

The Excel workbook contains two easy-to-read history sheets:

- **History:** Tournament name, winner, runner-up, number of participants.
- **Final Positions:** Tournament name, player position (1, 2, 3, ...), player name, result (Winner / Runner-Up / Participant).

Completed tournaments are **automatically compacted**. Old pairings, match-by-match scores, battle rooms, Pokémon team submissions, and check-ins are **discarded after the final positions are archived**. No chat message is ever saved. The old admin/player Hall of Fame screens still work.

### During a tournament only: minimum working data

The original login and tournament engine cannot function safely with ONLY four history fields. Consequently, the same private Excel workbook also stores:

- **Player accounts:** username, ID, password **hash** and win/runner-up counters, so they can log in after the Render Free service restarts. Plaintext passwords are never stored.
- **Unfinished tournaments:** registration roster, team entry, active pairings, check-ins, reports, interim scores and standings, so the ongoing tournament can recover after a restart.

These unfinished-event details are removed after completion. A `Records` worksheet contains the JSON working state needed by the existing dashboards; **do not edit or delete that worksheet**. This design preserves all existing functionality without storing old battle details forever.

| Historical data size | Measured current Excel workbook* |
|---|---:|
| 1 tournament × 32 players | 10 KB |
| 10 tournaments × 32 players | 17 KB |
| 100 tournaments × 32 players | 83 KB |
| 1,000 tournaments × 32 players | 731 KB |

*Approximate test files with no active player accounts or unfinished tournaments. Player logins/unfinished tournaments add some space. **GitHub stores an entire new binary Excel version with every save, so repository HISTORY uses more total storage than the latest `.xlsx` size**. This is intended for small-to-moderate tournaments, not large public competitions.

### One finished tournament example

`History`: `Sunday Pokémon Cup | TrainerOne | TrainerTwo | 32`

`Final Positions`: `Sunday Pokémon Cup | 1 | TrainerOne | Winner` etc.

### Tomorrow's event / go-live checklist (October 11, 2026)

1. Create the `limitless` website repository and separate **PRIVATE** `limitless-data` repository; do not commit passwords or tokens.
2. Follow steps 1–5 above to deploy **one** Render Free **Web Service**, using the existing Python backend and JavaScript dashboards.
3. Visit `/api/health`; expect `"status":"ok","storage":"github-excel"`. Confirm `limitless.xlsx` has appeared in your PRIVATE data repository.
4. Sign in to `/admin/` and create tomorrow's tournament. Open registration.
5. Register two test players in separate browsers and confirm both appear in Admin.
6. Begin the tournament and start its first round. Confirm both users can see pairings and share battle IDs in the temporary chat.
7. Finish the test event and download Excel from Admin. Inspect **History** and **Final Positions**; ensure no chat or old teams are present.
8. Delete your TEST results using the Admin Hall of Fame delete controls if you don't want them in the real event. (Accounts can also be removed using Admin > Players.)
9. Before the real event, open the Render site to wake it from idle and check that player signup and chat respond.

**Important:** the server has not been deployed to your account by this ZIP. You still need to create/connect the GitHub repositories and Render service, then perform the actual online two-player test. Do not share the website link publicly before that test.

## IMPORTANT free-plan limits and guarantees

- Render **Free**: after **15 minutes without inbound traffic**, the server spins down and may take **around a minute** to wake; a restart also clears temporary chat. Render can restart Free instances at other times. There is no guarantee of 24/7 zero-delay service. The site's persistent data remains in GitHub because of the new integration.
- Render may suspend a free service if bandwidth, instance hours, or other usage limits are exceeded. See <https://render.com/docs/free>.
- GitHub's Contents API has **rate limits**. Workbook commits are suitable for a small/moderate amateur tournament, **not hundreds of simultaneous score writes**. Avoid editing the GitHub workbook manually while a tournament is running.
- If GitHub is temporarily inaccessible or the token is invalid, durable saves **fail with an error**, rather than getting falsely accepted and then lost.
- Free plans and terms can change. We cannot guarantee this configuration will stay available for free forever.

## Running locally (optional)

For development without GitHub, leave `GITHUB_TOKEN` and `GITHUB_DATA_REPO` unset:

```sh
python -m pip install -r requirements.txt
# Set ADMIN_PASSWORD and SESSION_SECRET via environment variables, then:
python server.py
```

Browse <http://localhost:8000>. A local workbook is stored in `data/limitless.xlsx`. Local-only mode does **not** protect data if you deploy on an ephemeral free service.

## Checks

From the project folder, install requirements then run:

```sh
python tests/test_render_github.py
python tests/test_archive_and_size.py
```

The first test verifies player registrations, tournament state, cross-player battle-ID chat and restart recovery. A second test verifies that completing a tournament saves **only final placements and podium**, discards historical pairings and teams, and survives a restart. Both tests use a mocked GitHub API and require no real GitHub token. The test requires no actual GitHub token.

**Source files:** `public/` (existing dashboards), `server.py` (API), `github_excel.py` (GitHub workbook persistence), `requirements.txt` (Python dependencies), `Dockerfile` (optional alternative deployment). Never commit a real token, an admin password, or a `.env` file.
