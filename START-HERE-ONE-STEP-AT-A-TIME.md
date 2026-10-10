# LIMITLESS — STEP-BY-STEP SETUP FOR TOMORROW

Your existing Admin and Player dashboards are included. Use **GitHub (website code) + private GitHub Excel workbook + Render Free (running Python server)**. No payment card required for the advertised Free tier, but free availability and quotas are not guaranteed.

**Never share** your GitHub access token, admin password, or session secret with players or in GitHub files. You can share only the final `/player/` website link with players.

## STEP 1 — Extract the ZIP

1. Download `LIMITLESS-UPDATED-READY-TO-HOST.zip`.
2. Right-click → **Extract All**.
3. Open the extracted **limitless** folder.
4. Confirm you see `server.py`, `github_excel.py`, `requirements.txt`, `render.yaml` and the `public` folder.
5. These are files you will upload. **Do not upload the ZIP itself.**

## STEP 2 — Create WEBSITE GitHub repository

1. Open https://github.com/new and sign in.
2. Repository name: `limitless`.
3. Set **Private** or **Public**. (Both work for the GitHub repository; Render may need GitHub permission if private.)
4. Click **Create repository**. You can leave "Add a README file" unchecked for this code repo.
5. On the empty repository page, click **uploading an existing file**; or choose **Add file → Upload files**.
6. From extracted `limitless` folder, select all the files and folders **inside it**, drag them into the upload page, then click **Commit changes**.
7. At the repository root, verify `server.py`, `github_excel.py`, `requirements.txt`, `render.yaml`, and `public/` are visible. **Don't create an extra nested limitless folder**.

## STEP 3 — Create PRIVATE database repository

1. Open https://github.com/new again.
2. Repository name: `limitless-data`.
3. Choose **Private**.
4. **Check “Add a README file”** (creates the `main` branch).
5. Click **Create repository**.
6. Note your GitHub username: for example `trainer123` → data repository name is `trainer123/limitless-data`.
7. **Do not upload an Excel file.** The server creates `limitless.xlsx` automatically.

## STEP 4 — Create GitHub access token (secret)

1. Open https://github.com/settings/personal-access-tokens/new .
2. Token name: `limitless-excel`.
3. Select **Resource owner** = your own GitHub account.
4. Under **Repository access**, pick **Only select repositories**, then select **limitless-data** ONLY.
5. Under **Repository permissions** change **Contents** to **Read and write**.
6. Set token expiry to AFTER your event (or longer if you plan recurring events).
7. Click **Generate token** and copy it privately now. You may not be able to view it again.
8. **Do not send the token in ChatGPT, WhatsApp, or put it in GitHub.** It goes only into a private Render environment variable.

## STEP 5 — Create Render FREE Web Service (NOT Static Site)

1. Open https://dashboard.render.com and sign in with GitHub.
2. Select **New → Web Service**.
3. Choose **Build and deploy from a Git repository** and connect the `limitless` code repository (NOT `limitless-data`).
4. Name: `limitless-tournament` (or any available name).
5. Language/Runtime: **Python 3**. Branch: `main`. Root Directory: **leave empty**.
6. Build Command: `pip install -r requirements.txt`
7. Start Command: `python server.py`
8. Instance Type: **Free**. Check before deploying that Free is selected.
9. Before deploying, enter **Environment** variables from Step 6.

## STEP 6 — Add exactly these Render environment variables

| Variable | Value |
|---|---|
| `GITHUB_DATA_REPO` | `YOUR_GITHUB_USERNAME/limitless-data` |
| `GITHUB_TOKEN` | paste the private token made in Step 4 |
| `GITHUB_DATA_BRANCH` | `main` |
| `ADMIN_USER` | `admin` |
| `ADMIN_PASSWORD` | create your own strong password, never share it |
| `SESSION_SECRET` | create a DIFFERENT long random string (32+ characters), never share it |

**Render sets `PORT` automatically.** Don't make a `PORT` variable yourself. The admin password is NOT your GitHub password. **Do not type example text like `YOUR_GITHUB_USERNAME` literally**; replace it with yours.

## STEP 7 — Deploy and check Excel backup

1. Click **Deploy Web Service**. Check **Logs** if it fails.
2. Copy the `https://...onrender.com` address Render gives you.
3. Open `https://YOUR-RENDER-DOMAIN/api/health` and look for `"storage":"github-excel"`.
4. Open your private `limitless-data` GitHub repository. After successful startup, it should contain **limitless.xlsx** created by the server.
5. If the workbook never appears, check token permissions and `GITHUB_DATA_REPO` (do NOT share token screenshots).

## STEP 8 — Open admin and player pages

- Admin: `https://YOUR-RENDER-DOMAIN/admin/` → login with the `ADMIN_USER` and `ADMIN_PASSWORD` you set.
- Player: `https://YOUR-RENDER-DOMAIN/player/` → players register/sign in here.

Replace `YOUR-RENDER-DOMAIN` with your actual service name. Share only the PLAYER link with participants.

## STEP 9 — Two-player test before tournament

1. Log in to `/admin/` and create a small TEST tournament.
2. Register two different test users on two different browsers/phones at `/player/`.
3. Join the tournament with both players.
4. Admin: start the tournament/first round.
5. Player A: send a test battle ID in their match chat.
6. Player B: check that the battle ID appears. Chat stays temporary and isn't stored in Excel.
7. Finish the TEST tournament. Download Excel from Admin: **History** records tournament name, winner and runner-up; **Final Positions** records every player's rank.
8. You may remove the test tournament using the Admin controls.
9. Before the real event, open the site a few minutes early to wake the free server.

## IMPORTANT LIMITATIONS

- The code is packaged and tested, **not automatically deployed to your GitHub/Render accounts**.
- Render **Free** sleeps after about **15 minutes without traffic**; first access can take around a minute. Free instances can restart unexpectedly; messages currently in chat disappear on restart.
- The Excel workbook stays in the **private** GitHub data repository between Render restarts, so player accounts and historical positions are recoverable. **During an active tournament**, temporary match progress is also saved so an unexpected restart doesn't erase the event.
- GitHub may throttle writes during high-concurrency events. Test with your expected number of players. The Free plan does not guarantee uninterrupted service.
- The data repository must stay private; its whole Excel Git history also contains player usernames and password hashes. Never put private repository tokens in website JavaScript.

Want help one step at a time? Complete STEP 1, then send **“Step 1 done”**, and continue STEP 2.
