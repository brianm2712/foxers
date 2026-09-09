# Putting Foxxers on foxxers.com

Written to be run by you, on your machine and your server. Nothing here has
been executed — the server was never inspected, so treat the fenris01 specifics
as the pattern your other sites use rather than as verified facts, and check
them against what is actually there.

Foxxers is Node standard library only: no npm install, no build step. The whole
deploy is a copy, a `docker build`, and a tunnel.

---

## What has to survive a redeploy

One directory, `/app/data` in the container:

- **`foxxers.json`** — the entire database. Every foxxer, customer, quote,
  booking, invoice and payment.
- **`.session-key`** — generated at first run, signs every session token and
  every customer job link. Lose it and everyone is signed out and every
  `/j/<ref>?t=…` link a customer holds stops working.

Both live in the `foxxers_data` volume. The deploy script never touches it, and
`.dockerignore` keeps both out of the image — a `.session-key` baked into a
layer is a signing key shipped to anywhere that image goes.

## One-time setup on the server

```bash
ssh fenris01
docker volume create foxxers_data
```

Nothing else. No runtime to install; the image carries Node.

## Deploying

From this repo, on your Mac:

```bash
./scripts/deploy.sh
```

It runs the tests first and refuses to deploy if any fail, then rsyncs, builds
the image on the server, and swaps the container. Override anything with env
vars — `FOXXERS_HOST_SSH`, `FOXXERS_HOST_PORT`, `FOXXERS_REMOTE_DIR`.

**Run it outside any sandbox.** The suite binds localhost ports and fails with
`listen EPERM` under one, which looks like a broken test and is not.

## The tunnel

Your other sites reach the internet through Cloudflare tunnels, with configs in
`~/.cloudflared/` on fenris01. Foxxers wants the same shape:

```yaml
# ~/.cloudflared/foxxers.yml
tunnel: <tunnel-id>
credentials-file: /home/brian/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: foxxers.com
    service: http://127.0.0.1:8120
  - hostname: www.foxxers.com
    service: http://127.0.0.1:8120
  - service: http_status:404
```

Then, once:

```bash
cloudflared tunnel create foxxers
cloudflared tunnel route dns foxxers foxxers.com
cloudflared tunnel route dns foxxers www.foxxers.com
```

and run it the same way your existing tunnels are run — check
`systemctl --user list-units | grep cloudflared` on fenris01 and copy whatever
pattern `dragon-jitsu` uses rather than inventing a new one.

**Check 8120 is free on that box first.** Ports already in use over there
include 8080 (portfolio), 8082, 8093 (fenris-auth), 8097 (bjj-app) and 8099
(dj-site). If 8120 is taken, set `FOXXERS_HOST_PORT` and change the tunnel
config to match.

## Binding, and the mistake it prevents

The app defaults to `127.0.0.1`, which is right on a laptop and wrong inside a
container — loopback inside a container is unreachable from the host, and the
symptom is a refused connection that reads like the container never started.
The Dockerfile sets `FOXXERS_HOST=0.0.0.0`, and the container is published to
`127.0.0.1:8120` on the host, so it is still never directly exposed.

## Before real customers

- **`FOXXERS_PUBLIC_URL=https://foxxers.com`** is set by the deploy script. It
  is where Stripe sends people back to; wrong, and returning customers land on
  a dead page.
- **Payments stay off** until `FOXXERS_PAYMENTS=stripe` is set with a key. The
  default is `manual`, which records what would have happened and moves no
  money. That is the right default for a first deploy.
- **The webhook endpoint** becomes `https://foxxers.com/api/v1/webhooks/stripe`
  once this is live — the dashboard-endpoint half of `go-live.md`, which was
  written for a machine that had no public URL, now applies.
- **Seed data is demo data.** Do not run `scripts/seed.js` against the live
  volume; it writes six fictional tradespeople into the database.
- **The platform agreement has not been reviewed by a solicitor.** It is wired
  into onboarding and a foxxer cannot get a Stripe account without accepting
  it. See the top of `go-live.md`.

## Rolling back

The image is rebuilt from source each deploy, so rolling back is checking out
the previous commit and deploying again:

```bash
git checkout <previous-sha>
./scripts/deploy.sh
git checkout -
```

The data volume is untouched by any of it.

## Checking it worked

```bash
ssh fenris01 'curl -fsS http://127.0.0.1:8120/api/v1/health'
curl -fsS https://foxxers.com/api/v1/health
```

The first answering and the second not means the app is fine and the tunnel is
not. `docker logs foxxers` for anything else.
