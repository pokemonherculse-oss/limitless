# LIMITLESS: DO THESE SIX STEPS TO HOST

**No paid database, no payment card, and no frontend redesign.**

1. Extract this ZIP. Upload **everything in this folder** (including `public/`, `server.py`, `github_excel.py`, `requirements.txt`, `render.yaml`) to a GitHub repository called **limitless**.
2. Create a SECOND GitHub repository called **limitless-data**, set it to **PRIVATE**, initialize with a README. This will store only the Excel database and its Git version history.
3. Make a GitHub **fine-grained personal access token** at <https://github.com/settings/personal-access-tokens/new>. Limit it to **limitless-data ONLY**, set **Contents: Read and write**, and expiry past the tournament. **NEVER paste the token into this project or send it to anyone.**
4. On <https://dashboard.render.com/> choose **New > Web Service**, connect the **limitless** code repository, runtime **Python 3**, instance plan **Free**. Build command: `pip install -r requirements.txt`; start command: `python server.py`. Render generates `PORT` automatically. Do NOT choose Static Site.
5. In Render **Environment**, set:

   | Name | Value |
   |---|---|
   | `GITHUB_DATA_REPO` | `YOUR-USERNAME/limitless-data` |
   | `GITHUB_TOKEN` | the secret fine-grained token from step 3 |
   | `GITHUB_DATA_BRANCH` | `main` |
   | `ADMIN_USER` | `admin` |
   | `ADMIN_PASSWORD` | a strong personal password |
   | `SESSION_SECRET` | a **separate** long random string; keep the same value across deploys |

6. Deploy. Visit these three links (replace `YOUR-SERVICE` with the actual Render name):

   - `https://YOUR-SERVICE.onrender.com/api/health` -> should say `"storage":"github-excel"`.
   - `https://YOUR-SERVICE.onrender.com/admin/` -> sign in with `ADMIN_USER`/`ADMIN_PASSWORD`.
   - `https://YOUR-SERVICE.onrender.com/player/` -> two players register and join.

   **Test from TWO browsers** before the event: admin creates/open tournament, each player joins, admin starts the first round, player A sends a battle ID and player B receives it. When the event ends, **History** and **Final Positions** sheets show all results. Battle chat disappears; no chat is stored in Excel.

**Where is the Excel file?** The server creates `limitless.xlsx` in the **private limitless-data GitHub repository**, automatically. You don't upload it manually.

**Render Free warning:** after 15 minutes idle the service sleeps. Its next visitor wakes it, which may take about a minute. A free instance may also restart or become temporarily unavailable; battle chats (memory-only) disappear on restart. GitHub protects saved registration and final results. GitHub API/Render free quotas also apply; this is not guaranteed always-on hosting.

See `README.md` for full instructions, tests, caveats and the Excel size measurements. Never expose the private repository, the GitHub token, or the admin password.
