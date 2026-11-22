# Production hosting runbook

How to run ALFA for real money: one server, HTTPS, backups on the server and off-site, and a tested way to
restore. The test site on Vercel stays a demo; nothing here touches it.

## What runs

| Part | What it does |
| --- | --- |
| **app** | The ALFA server and the four web apps (image `ghcr.io/judejbpb/prepaid-fuel`, built on every merge to `main`). The database is one SQLite file in the `alfa-data` volume. Every commit is written to disk before it is confirmed. |
| **caddy** | HTTPS on your domain. It gets and renews the certificate automatically, redirects http to https and adds security headers. |
| **litestream** | Copies every database change, about once a second, to object storage in another place. It keeps 30 days of history, so the database can be restored to any moment in that window. |
| **Local snapshots** | Every 6 hours the app writes a checked copy of the database to `/data/backups` and keeps the last 28 (7 days). |

`/api/health` answers 200 when the database works and the last snapshot is recent. It answers 503 otherwise,
so an uptime monitor can alert you.

## What you need

1. **A server.** Any Linux VPS with Docker works: 2 vCPU, 4 GB RAM and 40 GB disk is plenty for the pilot.
   Examples are Hetzner CX22 (around €5 a month) and DigitalOcean (around $12 a month). Check current prices
   and whether Bandari or its bank needs the data kept in a particular country.
2. **Object storage for the off-site copy.** Use a different provider or region from the server, for example
   Cloudflare R2 (the first 10 GB are free), Backblaze B2 or DigitalOcean Spaces. Create:
   - a private bucket;
   - an access key that can only read and write that bucket.
3. **A domain name**, for example `alfa.bandari.ht`, with an **A record** pointing at the server's IP address.
4. **An uptime monitor** on `https://<domain>/api/health`. UptimeRobot or Better Stack have free plans. Send
   the alerts to two people.

## First installation

On the server:

```bash
# Docker (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh

# The deploy kit
git clone https://github.com/judejbPB/Prepaid-fuel.git alfa && cd alfa/deploy
cp .env.example .env && chmod 600 .env
nano .env        # DOMAIN, ACME_EMAIL, ADMIN_LOGIN/PASSWORD, LITESTREAM_* (and ANTHROPIC_API_KEY if wanted)

# The image is private while the repository is private: sign in once with a GitHub token
# that has read:packages (github.com → Settings → Developer settings → Personal access tokens).
echo <token> | docker login ghcr.io -u <github-user> --password-stdin

docker compose up -d
docker compose ps          # app should be "healthy" within a minute
```

Then:

1. Open `https://<domain>`, sign in to the distributor control center with `ADMIN_LOGIN` /
   `ADMIN_PASSWORD`, and **change the password**.
2. Remove `ADMIN_PASSWORD` from `.env`. It's only used to create the first account on an empty database.
3. Set up the rest from the control center: client companies, contract prices, stations, terminals and staff.
4. Run the **restore drill** below once. A backup you have never restored is not yet a backup.

The server refuses to start in production:
- on an empty database without `ADMIN_LOGIN` / `ADMIN_PASSWORD`;
- on a database that still holds the demo accounts. `npm run seed` also refuses to run there.

## Backups and restoring

**Restore drill: monthly, and after changing storage keys.** It restores the latest off-site copy to a scratch
file, checks SQLite integrity, the ledger's balance rules and the record counts, then deletes the scratch file.
It never touches the live database.

```bash
cd ~/alfa/deploy && ./restore-drill.sh      # ends with "Restore drill passed."
```

**Real restore.** Use it when the server is lost or the database is damaged. Start the stack on a new server
with the same `.env`, then:

```bash
docker compose stop app litestream
docker compose run --rm --no-deps --entrypoint sh litestream -c \
  "rm -f /data/bousol.db /data/bousol.db-wal /data/bousol.db-shm && \
   litestream restore -config /etc/litestream.yml -o /data/bousol.db /data/bousol.db"
#   to a moment in time, add:  -timestamp 2026-11-03T14:00:00Z
docker compose up -d
docker compose exec app node_modules/.bin/tsx server/src/verify-db.ts /data/bousol.db
```

**From a local snapshot**, if the off-site copy can't be reached: stop the app, then copy a snapshot over the
database. Snapshots are named by UTC time, e.g. `/data/backups/alfa-20261103T120000Z.db`.

```bash
docker compose stop app
docker compose run --rm --no-deps --entrypoint sh app -c \
  "cp /data/backups/<snapshot>.db /data/bousol.db && rm -f /data/bousol.db-wal /data/bousol.db-shm"
docker compose up -d
```

After any restore, check in the control center that the ledger balance check is green and that the last
deposits and fuelings are there. Then tell the stations to resync their terminals.

## Updates and rolling back

Every merge to `main` publishes `:latest` and `:sha-<commit>`.

```bash
cd ~/alfa/deploy && docker compose pull app && docker compose up -d app
curl -s https://<domain>/api/health     # "version" shows the commit now running
```

The app finishes requests in progress and closes the database cleanly before it restarts. Update outside
fueling peaks; the restart takes a few seconds, and offline terminals keep selling during it.

To roll back, set `ALFA_IMAGE=ghcr.io/judejbpb/prepaid-fuel:sha-<previous commit>` in `.env`, then run
`docker compose up -d app`. Database changes are always additions (new tables and columns), so an older
version still opens a newer database.

## Day to day

- **Logs:** `docker compose logs -f app`. Logs are capped at 5 × 20 MB per service.
- **Disk:** keep at least 30 % free. `docker system prune` removes old images after updates.
- **Server updates:** apply OS security updates monthly (`unattended-upgrades` on Ubuntu). Restart Docker
  services after kernel updates.
- **Secrets:** `.env` holds the storage keys and the AI key. Keep it readable only by the admin
  (`chmod 600`), never commit it, and rotate the keys if someone with server access leaves.

## Not covered here (separate ClickUp items)

- **Security hardening and an external penetration test:** rate limiting, sign-in protection, firewall rules
  and a review of every role's access.
- **A second server for zero-downtime updates.** One server is enough for the pilot.
- **Google Play release** of the station and wallet apps. They need to point at the production domain.
