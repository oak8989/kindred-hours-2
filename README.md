# Kindred Hours 2

A self-hosted volunteer portal with a React frontend and a Node 24 / SQLite server. No Supabase or Neon account is used. **This is an early self-hosted release, not yet an independently audited production deployment.** See [Known limitations](#known-limitations) before exposing it to real users.

## Prerequisites and installation

- Docker Engine with Compose v2, a recent computer or server, and a working internet connection for the initial image build. Allocate at least 1 GB memory.
- From a fresh checkout, copy `.env.example` to `.env`. Edit **only** deployment values in `.env`; no application source edits are required.
- Choose an unused `HOST_PORT` (default `3000`). On Linux/macOS, `ss -ltn` or `lsof -i :3000` can show listeners; on Windows, `netstat -ano` can show listeners. If Docker reports a bind error, choose another port and start Compose again. Docker maps `${HOST_PORT}` on your computer to port `3000` inside the container. The in-browser setup wizard cannot change or verify a host port after Docker has already bound it.
- Run `docker compose up -d --build`. View status with `docker compose ps` and diagnostic output with `docker compose logs -f app`. Open `http://localhost:3000` (replace `3000` with `HOST_PORT`). The first visitor is shown the setup wizard.

> The first admin account is created in the wizard with a password you choose (minimum 12 characters). There is no shipped password. Restrict access to the initial setup page until it is complete; anyone who reaches an uninitialized public instance could create the first administrator.

### First-run wizard and email

1. Select the host port in `.env` **before** starting the container. Confirm that Docker has started successfully; that is the effective availability test.
2. Enter the organization name, accent color, and initial admin name/email/password in the wizard.
3. File delivery works immediately. Account setup and password reset messages are saved as private files under `./data/assets/`. Read them on the Docker host, **not** via the web app. Protect this directory because its messages contain one-time links.
4. In **Administration → Settings**, upload a logo, change branding, configure SMTP, and send a test email to the signed-in admin address. SMTP supports host, port, implicit TLS or STARTTLS, username/password, and sender address. Use a trusted SMTP provider with a valid certificate. The SMTP password is stored in SQLite; restrict host and backup access.
5. Console mode logs delivery notices without message bodies or reset links. It is **not** suitable for onboarding or password reset. Use file mode or SMTP for those workflows.

Environment variables: `HOST_PORT`, `BIND_ADDRESS`, `TRUST_PROXY` are deployment settings in `.env`. Organization name, logo, brand color, SMTP host/port/encryption/username/password/sender are configured through the administrator interface and stored in `./data/kindred.sqlite`. `PORT`, `DATA_DIR`, and `NODE_ENV` are set by Compose for the container. Do not add credentials to `.env`, commit `.env` or `data/`, share backups, or publish the file delivery directory. Store backups encrypted. The default binding is localhost only (`127.0.0.1`).

## Using the portal

- A volunteer registers with name and email, opens the one-time setup link (30-minute expiry), and chooses a password. Existing addresses get the same generic registration response. Sign-in uses an HttpOnly SameSite=Strict cookie; password reset uses single-use 30-minute links and generic responses.
- Administrators and assistants can create public or members-only events, manage individual occurrences or whole series, and record staff-assisted attendance and walk-ins. Enter dates in the selected IANA event time zone. Repeating events keep the same local time through daylight-saving transitions; nonexistent spring-forward times are rejected, and the first occurrence of an ambiguous fall-back time is used. Monthly repeats on dates absent in a month use that month's last day. Registration is capacity-checked in a SQLite write transaction. Staff record check-in and check-out once per member/event; completed attendance contributes to hours and medals.
- QR attendance: members display a short-lived member QR for staff to scan, or scan the event QR shown by staff. Camera scanning uses the browser's BarcodeDetector API over HTTPS or localhost; if unsupported, enter the short code printed under the QR. Codes expire within five minutes, are signed server-side, require a signed-in account and are checked against event timing. Event QR self-service requires registration; staff can scan member QR for walk-ins. Repeated scans return an idempotent result.
- Members can edit their name, register/cancel, read and sign the latest waiver version, review attendance and milestones. Administrators can publish new waiver versions, define medals, manage roles/branding/email, and assistants can export member and attendance CSVs. CSV formula injection is escaped.

## Storage, upgrades, backups and restore

Compose bind-mounts `./data` to `/app/data`. SQLite (`kindred.sqlite`, `kindred.sqlite-wal`, `kindred.sqlite-shm`) and logos/private mail files (`assets/`) persist when the container is replaced. The server records applied schema versions in the `migrations` table. Version 2 adds indexes and is applied automatically in a transaction to existing databases. Back up before every upgrade.

For a consistent backup, stop writes with `docker compose stop app`, archive the entire `data/` directory including SQLite WAL/SHM and `assets/`, then `docker compose start app`. For restore, stop the app, move the current `data/` aside, extract the archived `data/` into the project root, check its permissions, and start the app. Test restore to a separate machine before relying on a backup. Keep archived message files and SQLite encrypted/offsite according to your retention policy.

To upgrade, back up `data/`, pull the updated checkout/image, then `docker compose up -d --build`. Keep a copy of the previous image and data for rollback. The Docker build runs the isolated Node smoke test automatically and stops if it fails. Use `docker compose ps` and `/healthz` to confirm the new container is healthy.

The smoke test (`node --test src/backend/smoke.test.mjs`, also run during Docker image build) starts an isolated server and temporary database, then checks first-run setup, account setup and reset links in file mode, public events, DST recurrence, registrations, waiver signatures, medal creation, QR attendance, role permissions and CSV export. It does not test a real SMTP provider or prove that your host port, router, firewall, DNS and reverse proxy are configured correctly. To verify SMTP, configure a real provider in Settings, send a test message and confirm delivery to the admin inbox; also test registration and reset emails. Verify Compose by completing the wizard on the target Docker host, checking container health and exercising the member, assistant and admin workflows through its public HTTPS address.

## Network and internet access

- For LAN access, set `BIND_ADDRESS=0.0.0.0`, restart Compose, allow only your trusted LAN to reach `HOST_PORT` in the host firewall, and visit `http://<host-LAN-IP>:<HOST_PORT>`. Plain HTTP on a LAN is not appropriate for untrusted networks.
- For internet access, **do not publish this app directly over HTTP.** Use a domain with a DNS A/AAAA record pointing to your public IP, forward TCP 80/443 on your router to a maintained reverse proxy (Caddy, Traefik, or nginx) on the host, and configure the proxy for automatic HTTPS certificates and to forward to `127.0.0.1:${HOST_PORT}`. Set `TRUST_PROXY=1` only for a trusted proxy that overwrites `X-Forwarded-Proto`; set your firewall to expose only 80/443 and never expose port 3000 or the `data/` directory to the internet. If the proxy runs in another Docker container, place it and the app on a private network rather than binding the app publicly. Ensure the proxy preserves the original Host and Origin headers. Use HTTPS before inviting members because cookies are only marked Secure when requests arrive through HTTPS. Docker alone does not set up DNS, firewall rules, router forwarding, TLS, or a reverse proxy. CGNAT may require a tunnel/VPN or hosting provider instead of router forwarding.
- Restrict initial setup to the admin's network. Review server security, rate limits, SMTP settings and your reverse proxy configuration before real-world deployment.

## Troubleshooting

- **Port already in use:** change `HOST_PORT` in `.env` and recreate with Compose. The wizard cannot release or remap a host port.
- **Unhealthy container:** check `docker compose logs app`, available disk space, and write access to `./data`. The health probe is `/healthz`.
- **No invitation/reset email:** file mode writes private files in `data/assets/`; console mode deliberately omits links; SMTP requires reachable host, valid credentials and TLS. Test using Administration → Settings.
- **Cannot sign in:** check link expiry (30 minutes), the password length, and the browser's same-origin HTTPS proxy configuration. If cookies were blocked, retry via the canonical URL.
- **Missing events:** private events are visible only after sign-in. Canceled and past events are excluded from public listings.

## Known limitations

The Docker build now includes an isolated integration smoke test, but this workspace has not run an actual Docker engine or external SMTP delivery test. Host port selection and availability must happen before Compose starts; a browser wizard cannot alter a running container's published port. Camera scanning depends on browser support for BarcodeDetector; manual code entry remains available. Console mode only logs a notice and cannot deliver account links. This system has not received an independent security review: do not describe it as fully production-verified or expose it to real users until the Compose/SMTP acceptance tests and security review succeed on your target deployment.
