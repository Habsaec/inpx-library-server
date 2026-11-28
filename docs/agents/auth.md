# Auth (pairing, OIDC, app TLS)

Part of the INPX Library Server agent spec. The rules every task must obey are in
[`AGENTS.md`](../../AGENTS.md); this file is the detailed reference of one subsystem.
Read it before changing that area and update it in the same commit as the code.

Scope: sign-in paths that are not a plain web login

---

## OIDC / SSO (web login)

Optional OpenID Connect login (Authentik-compatible): Authorization Code + PKCE, JIT user provisioning, optional admin claim. Configure in **Admin → Users → OIDC / SSO** (`oidc_enabled` off by default). Routes: `GET /auth/oidc/start`, `GET /auth/oidc/callback`. Session cookie contract unchanged. OIDC users get `has_local_password=0` until they set a password in profile (needed for OPDS/Basic). Existing local accounts with the same email are **not** auto-linked.

## Pairing

- `POST /api/auth/pairing` — authenticated; creates a one-time 10-minute QR pairing code (`payload` JSON + `svg`) for Android app sign-in; does not include the password
- `POST /api/auth/pairing/redeem` — public + rate-limited; exchanges pairing `code` for a device Bearer token (`deviceToken`, `deviceTokenId`, `username`, `serverUrl`)

## Android HTTPS

- Android HTTPS with a home CA (app-only): the app's `network_security_config.xml` trusts `system` + `user` certificate stores, so a server behind a reverse proxy with a certificate from the owner's own CA (mkcert) works once that CA is installed in Android settings; chain and host name checks are not relaxed, there is no per-server CA import. No server API
