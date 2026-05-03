# Lightning Repairs — Daily Ticket Tracker
## Setup Instructions (5-10 minutes)

---

## STEP 1 — Set up Supabase database

1. Go to https://supabase.com and open your project
2. Click **SQL Editor** in the left sidebar
3. Click **New query**
4. Open the file `schema.sql` from this folder and paste the entire contents
5. Click **Run** — you should see "Success"

This creates all your tables and seeds the initial data (device types, repair types, book times, technicians).

---

## STEP 2 — Deploy to Netlify

1. Go to https://netlify.com and sign up for a free account
2. From your dashboard click **"Add new site" → "Deploy manually"**
3. You'll need to build the app first — see Step 3

---

## STEP 3 — Build the app

You need Node.js installed. If you don't have it: https://nodejs.org (download the LTS version)

Open a terminal/command prompt in this folder and run:

```
npm install
npm run build
```

This creates a `build` folder.

---

## STEP 4 — Deploy

1. Drag and drop the `build` folder onto the Netlify deploy page
2. Netlify will give you a URL like `https://random-name.netlify.app`
3. You can rename it under Site Settings → Change site name

---

## STEP 5 — Share with your team

Send the URL to your techs. That's it!

---

## Default logins

| Name    | PIN  | Role  |
|---------|------|-------|
| Samuel  | 1111 | Admin |
| Zach    | 2222 | Tech  |
| Drew    | 3333 | Tech  |
| Chase   | 4444 | Tech  |
| Aaron   | 5555 | Tech  |

**Change PINs immediately** — go to Admin Panel → Technicians → Change PIN

---

## What each role can do

**Tech:**
- Log tickets on their daily sheet
- Start/pause/stop timers
- See their own efficiency stats

**Admin (Samuel by default):**
- Everything a tech can do
- Manager View — see ALL techs' sheets in real time
- Admin Panel:
  - Edit book times (click any cell to change)
  - Add/disable device models and repair types
  - Add/manage technicians and PINs

---

## Updating book times

1. Log in as Samuel (or any admin)
2. Click **Admin Panel** in the top nav
3. Select a device type
4. Click any cell to edit the book time
5. Type the new minutes and press Enter — saves instantly

---

## Notes

- Data saves automatically as techs type — no submit button needed
- Closing the browser tab is fine — data is in the cloud
- Manager view updates in real time — refresh not needed
- The app works on phones and tablets too
