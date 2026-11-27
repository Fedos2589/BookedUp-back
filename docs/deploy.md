# Deploy and operations

One server (Hetzner, Ubuntu 24.04, x86), Docker Compose, Caddy with automatic HTTPS. The plan and the reasons
(D1–D23) are in `docs/superpowers/plans/2026-11-26-e21-deploy.md`; what to buy and register by hand is in
`2026-11-26-e21-deploy-by-hand.md` next to it. Every command below runs on the server in `/opt/bookedup` unless
it says «laptop».

## What runs where

```
Internet ─443/80─▶ web (Caddy: the front's files on /, /api/* → api with the prefix stripped, /api/docs* as is)
                   api (the API and the notifications worker) ─▶ postgres (volume) · redis (volume)
cron hourly  backup.sh         → /var/backups/bookedup (48 h) → restic → Backblaze B2 ─▶ ping «backup»
cron weekly  offsite-check.sh  ← restic restore from B2 → scratch database → counts   ─▶ ping «restore»
```

The database is the only state. Images are in GHCR, code in GitHub, secrets in `.env` and `api.env` (a copy of both
whole is in the password manager entry «BookedUp server»; without `RESTIC_PASSWORD` nobody can read the off-site
copies).

## First deploy

The steps R1–R16 of the plan, in order: SSH key, images (Release workflow in both repos, packages made public),
server, domain, Telegram bot, `server-setup.sh` as root, B2 and healthchecks.io, `.env` and `api.env`, the first
`deploy.sh` with both shas, webhook, backups, uptime ping, `smoke.sh`.

## Update

From the laptop, after Release has built the images of the commit:

```bash
deploy/deploy.sh deploy@<ip> <api-sha> <web-sha>   # "-" or an omitted sha keeps what runs now
deploy/smoke.sh <domain>                           # every line ok
```

The deploy copies `deploy/`, checks both images exist, takes a backup, pulls, runs `prisma migrate deploy`, restarts,
waits for `/api/health` and only then writes the new images to `.env` and a line to `releases.log`.

## Rollback

Take the previous shas from `releases.log` (`ssh deploy@<ip> tail -n 5 /opt/bookedup/releases.log`; each line is
`<time> <api-sha> <web-sha>`) and deploy them:

```bash
deploy/deploy.sh deploy@<ip> <previous-api-sha> <previous-web-sha>
```

**Migrations are not rolled back.** If the old code can't read the schema the new release migrated, restore the
dump this deploy took (the deploy prints its path as «restore point») — see «Restore (a)».

## Backups

- Hourly `pg_dump -Fc` and one before every deploy, in `/var/backups/bookedup` (48 hours kept).
- Every dump also goes to B2 with restic (encrypted on the server): 48 hourly, 30 daily, 12 weekly, 11 monthly. The
  bucket has Object Lock (30 days, governance) and the server's key can't lift it: a deleted file only gets hidden
  and stays readable for 30 days, so a break-in can't wipe the history.
- Up to one hour of data may be lost in a crash (no WAL archiving).
- Two pings on healthchecks.io: `bookedup-backup` (silent for 2 h → alert) and `bookedup-restore` (weekly restore
  check from the bucket, not from the local copy).
- Log: `/var/log/bookedup-backup.log`. Run by hand: `/opt/bookedup/backup.sh`, `/opt/bookedup/offsite-check.sh`.

## Restore

**(a) From the server's own dump** (the database is damaged, the server is fine). The deploy's «restore point» or
the newest `/var/backups/bookedup/bookedup-*.dump`. First stop the hourly backup: a dump taken in the middle of the
restore would go to B2 as the newest snapshot.

```bash
sudo mv /etc/cron.d/bookedup-backup /root/
docker compose stop api
docker compose exec -T postgres dropdb -U bookedup bookedup
docker compose exec -T postgres createdb -U bookedup bookedup
docker compose exec -T postgres pg_restore -U bookedup --no-owner --exit-on-error -d bookedup < /var/backups/bookedup/<file>.dump
docker compose start api
deploy/smoke.sh <domain>        # laptop
sudo mv /root/bookedup-backup /etc/cron.d/
```

**(b) From B2 onto a new server** (the old one is gone). You need only the password manager entry. Do **not** restore
`latest`: once the new server is deployed, its hourly backup sends the empty database to B2, and `latest` is that.

1. Create the server as in R3 and point DNS at it (R4). Run `server-setup.sh` as root (R6).
2. **Stop the hourly backup now**, before anything else: `ssh deploy@<ip> sudo mv /etc/cron.d/bookedup-backup /root/`.
3. Put `.env` and `api.env` from the password manager into `/opt/bookedup` (mode 600), then
   `deploy/deploy.sh deploy@<ip> <api-sha> <web-sha>` from the laptop (R9; the shas of the release that ran last).
4. On the server, pick the snapshot **by id**: the newest one from before the failure whose size looks like a real
   database (an empty one is a few KiB):

   ```bash
   cd /opt/bookedup && set -a; . ./.env; set +a
   mkdir -p /tmp/restore
   restic() {
     docker run --rm --user "$(id -u):$(id -g)" -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID \
       -e AWS_SECRET_ACCESS_KEY -v /tmp/restore:/restore restic/restic:0.17.3 --no-cache "$@"
   }
   restic snapshots --host bookedup --tag db          # note the id (and the size)
   restic restore <id> --target /restore
   docker compose stop api
   docker compose exec -T postgres dropdb -U bookedup bookedup
   docker compose exec -T postgres createdb -U bookedup bookedup
   docker compose exec -T postgres pg_restore -U bookedup --no-owner --exit-on-error -d bookedup < /tmp/restore/backups/<file>.dump
   rm -rf /tmp/restore
   docker compose start api
   ```

5. Set the Telegram webhook again if the domain changed (R10), `deploy/smoke.sh <domain>` from the laptop, check
   a known business in the browser, then turn the backup back on: `sudo mv /root/bookedup-backup /etc/cron.d/`.

**(c) After a break-in.** Rotate the B2 application key first (the attacker has the old one), put the new one in
`.env` and the password manager. Then restore from a snapshot **older than the break-in**: `restic snapshots` lists
them, `restic restore <id> …` as in (b). Files the attacker «deleted» are only hidden and stay locked for 30 days.
To see and bring them back (b2 CLI v4; check these two commands on the bucket in R11 and correct them here):

```bash
b2 ls --versions --recursive b2://<bucket>
b2 file unhide b2://<bucket>/<path>
```

Rebuild the server from scratch (R3, R6) rather than cleaning it, and change every secret in `.env`, `api.env` and the
bot token.

## Logs, restart, reboot

```bash
docker compose logs -f --since 1h api          # on the laptop add: | npx pino-pretty
docker compose restart api
docker compose ps
```

Cookies and secrets are redacted in the logs, but they still hold IP addresses: don't keep copies.

**Reboot.** Security updates install by themselves but never reboot. When `/var/run/reboot-required` exists:
`sudo reboot` at a quiet hour (the sudo password of `deploy` is in the password manager). Containers and Docker
start by themselves; check with `deploy/smoke.sh <domain>`.

**Running `server-setup.sh` again** is safe, but it also runs `apt-get upgrade`, which can upgrade Docker and restart
every container: do it at a quiet hour, like a reboot.

## When something is lost

- **SSH is lost:** Hetzner Console → the server → Rescue, or «Reset root password» and the web console.
- **Certificates:** they live in the `caddy_data` volume. Never run `docker compose down -v` (it deletes the
  database too). Without the volume Caddy asks for new certificates, but Let's Encrypt limits how many.
- **A forgotten owner password** (until the reset flow, P1, is deployed). The hash is scrypt in the
  `$scrypt$ln=17,r=8,p=1$…` format, made by the API's own hasher; the password never goes into shell history:

  ```bash
  read -rs NEW_PASSWORD && export NEW_PASSWORD
  hash=$(docker compose run --rm -T --no-deps -e NEW_PASSWORD --entrypoint node api --input-type=module -e "
  import { PasswordHasher } from '@nestjs/authentication';
  process.stdout.write(await new PasswordHasher().hash(process.env.NEW_PASSWORD));
  ")
  docker compose exec -T postgres psql -U bookedup -d bookedup -v ON_ERROR_STOP=1 -v email='owner@example.com' -v hash="$hash" <<'SQL'
  UPDATE password_logins SET password_hash = :'hash', updated_at = now()
    WHERE user_id = (SELECT id FROM users WHERE email = lower(:'email'));
  DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = lower(:'email'));
  SQL
  unset NEW_PASSWORD
  ```

  `UPDATE 1` means it worked; the `DELETE` signs the account out everywhere.
