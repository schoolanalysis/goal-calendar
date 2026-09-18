# Goal Calendar

A small website where anyone can create their own free account and write
private goals for each day on a calendar. No third-party login — just
email and password, stored in your own database.

## How it works

- **Backend:** Node.js + Express
- **Database:** SQLite (a single file, `data.sqlite`, created automatically)
- **Accounts:** email + password, hashed with bcrypt, sessions via a signed cookie
- Each user's goals are stored under their own account and are never visible
  to other users.

## Running it locally

You'll need [Node.js](https://nodejs.org) 18 or later installed.

```bash
cd goal-calendar-app
npm install
npm start
```

Then open **http://localhost:3000** — create an account and try it out.

## Before you deploy this publicly

1. **Set a real session secret.** Set an environment variable:
   ```bash
   SESSION_SECRET="a-long-random-string-you-generate"
   ```
   If you skip this, the app will still run but warns you in its logs and
   uses an insecure default — anyone who knows it could forge login sessions.
   Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

2. **Use HTTPS.** The app sets `secure: true` on cookies once
   `NODE_ENV=production` is set, which requires HTTPS. Most hosts below give
   you HTTPS automatically.

3. **Back up `data.sqlite` regularly.** It's the only copy of everyone's
   accounts and goals. Some hosts wipe local disks on redeploy — see the
   notes per host below.

## Deploying it so people can find it online

You said you don't need help with the domain/search part, but here's the
short version of getting it *running* on the public internet. Any of these
work well for a small Node app like this:

### Render (simplest, free tier available)
1. Push this folder to a GitHub repository.
2. On [render.com](https://render.com), create a new **Web Service** from
   that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables: `SESSION_SECRET` (see above) and
   `NODE_ENV=production`.
5. Add a **persistent disk** mounted at `/opt/render/project/src` (or wherever
   your app runs from) so `data.sqlite` survives restarts — Render's free
   tier disks are ephemeral otherwise.

### Railway / Fly.io
Similar flow: connect the repo, set the same two environment variables, and
attach a persistent volume for `data.sqlite`. Both have free/low-cost tiers
and give you a public URL immediately.

### A basic VPS (DigitalOcean, Linode, etc.)
1. Install Node.js on the server.
2. Copy this folder over (`git clone` or `scp`).
3. `npm install --production`
4. Run it behind a process manager so it restarts on crash/reboot:
   ```bash
   npm install -g pm2
   pm2 start server.js --name goal-calendar
   pm2 save
   ```
5. Put [Caddy](https://caddyserver.com) or Nginx in front of it for free
   automatic HTTPS, then point your domain's DNS at the server.

Once it's live and you own a domain, pointing the domain at whichever host
you chose (an A record or CNAME, per that host's instructions) is the last
step — and search engines will index it on their own over time once it's
publicly reachable and linked from anywhere.

## Project structure

```
goal-calendar-app/
  server.js        the whole backend: auth + API + serving pages
  package.json
  public/
    login.html
    register.html
    app.html        the calendar (only served to signed-in users)
    app.js           calendar logic, talks to the API
    style.css
```
