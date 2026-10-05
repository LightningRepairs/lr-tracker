# Lightning Repairs Tech Tool — setup

How it fits together:

- `public/index.html` is the whole app the techs see.
- `netlify/functions/api.mjs` (+ `lib/`) is the server. It runs on Netlify, holds the RepairShopr API key and database password, and is the only thing that talks to RepairShopr and Supabase. The browser never sees either key.
- `db/schema.sql` creates the database in a new Supabase project. This is separate from the old lr-tracker database, which isn't touched.

Nothing secret lives in this repo. All keys go in Netlify environment variables.

---

## 1. Supabase (about 5 min)

1. Go to supabase.com → **New project**. Call it `lr-tech-tool`, pick region **East US (Ohio)**, and set a database password. Save that password somewhere; you need it in step 4.
2. Once it's created, open **SQL Editor → New query**, paste in all of `db/schema.sql`, and click **Run**. It should finish with "Success".
3. Set your own admin PIN. In a **new** query, run this with your 4 digits in place of 1234:
   ```sql
   select set_pin('samuel', '1234');
   ```
   Don't save this query, and don't put the PIN in any file. Everyone else's PIN gets set later from inside the app.
4. Click **Connect** (top of the project page) → **Transaction pooler** and copy the URI. It looks like
   `postgresql://postgres.xxxxx:[YOUR-PASSWORD]@aws-0-us-east-2.pooler.supabase.com:6543/postgres`.
   Replace `[YOUR-PASSWORD]` with your database password (no brackets).

## 2. Netlify environment variables

Netlify → your **lightningrepairs** site → **Site configuration → Environment variables → Add a variable**:

| Key | Value |
|---|---|
| `DATABASE_URL` | the pooler URI from step 1.4 |
| `SESSION_SECRET` | any 40+ random letters and numbers (mash the keyboard). This signs login sessions. |
| `RS_API_KEY` | your RepairShopr API token |

**RepairShopr token:** RS Admin → API → API Tokens → New. It needs permission to **view and edit tickets**, **create ticket comments**, and **list users**. Anything the app writes to RS (assignments, notes) shows up as done by this token's user. Notes also carry the tech's name as the comment's "tech".

## 3. Put the code in GitHub

On github.com/LightningRepairs/lr-tracker:

1. **Add file → Upload files**. Drag in everything from this folder (`netlify.toml`, `package.json`, `SETUP.md`, `.gitignore`, and the `public`, `netlify`, `lib`, `db` folders), then **Commit changes**. This replaces `public/index.html`, `package.json` and `netlify.toml`.
2. Delete the old app's leftovers: the `src` folder (open it → `…` → **Delete directory**), plus `schema.sql`, `migration2.sql` and `migration10.sql` at the top level.
3. Optional but recommended: **Settings → Change visibility → Private**. Netlify works fine with private repos.

## 4. Make sure Netlify builds from GitHub

Netlify → site → **Site configuration → Build & deploy → Continuous deployment**.

- If you see **Link repository**: link it to GitHub → `LightningRepairs/lr-tracker`, branch `main`. Leave the build command and publish directory blank, because `netlify.toml` sets them.
- If it's already linked, the commit from step 3 deploys by itself. Watch it under **Deploys**.

(Drag-and-drop deploys can't run the server part, so the site has to build from GitHub.)

**Rollback:** if anything goes wrong, go to **Deploys**, click the last old lr-tracker deploy, and choose **Publish deploy**. The old app is back instantly.

## 5. Check it

1. Open `https://lightningrepairs.netlify.app/api/health`. You want all three `env` values `true` and `"database": "ok (6 people)"`.
2. Open the site and log in with your PIN.
3. **Admin Console → RepairShopr connection** runs a live check. Then:
   - Tick the statuses that mean "diagnosed, waiting" (these drive *Diagnosis credit available*). The defaults are guesses.
   - Check that the Issue Types map the way you expect.
4. **Admin Console → Users**: anyone whose name exactly matches their RS user is linked automatically. Link everyone else by hand, then set each person's PIN and positions.

If something looks wrong, copy the "Sample ticket (raw from RepairShopr)" box on the connection page and paste it to Claude.

---

## Settings you can change (optional env vars)

- `RS_SUBDOMAIN`: defaults to `lightningrepair`
- `SHOP_TZ`: defaults to `America/Indiana/Indianapolis`. "Today" is always the shop's day.
