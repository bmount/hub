#!/usr/bin/env python3
"""Pimwell's Cloudflare setup, as code.

Every change pimwell needs in Cloudflare that wrangler.jsonc cannot express lives here, so the
account can be rebuilt and audited. Secrets come from the macOS Keychain and are never printed.

  python3 scripts/cf/cf.py whoami                 # which credential is in use and what it can do
  python3 scripts/cf/cf.py make-deploy-token      # needs the bootstrap token; mints pimwell-deploy
  python3 scripts/cf/cf.py dns-wildcard           # proxied * record for tenant subdomains
  python3 scripts/cf/cf.py audit                  # read-only report of everything pimwell depends on

Keychain items (service names):
  pimwell-cloudflare-bootstrap  a short-lived token that can create tokens; delete it after use
  pimwell-cloudflare-dev        token pimwell-001: the developer + deploy credential used by
                                humans, deploy agents and (later) the self-modifying hub
"""
import json, subprocess, sys, urllib.request, urllib.error, datetime

API = "https://api.cloudflare.com/client/v4"
ACCOUNT_ID = "f48d61ea6cf57096b3f7bcb02fa0c3e5"
ZONE = "pimwell.com"
BOOTSTRAP = "pimwell-cloudflare-bootstrap"
DEPLOY = "pimwell-cloudflare-dev"  # token pimwell-001: developer + deploy

# What a pimwell deploy needs, by permission-group name. Account-scoped unless marked zone.
ACCOUNT_GROUPS = [
    "Workers Scripts Write",       # hub Worker, ardi-pimwell, Durable Objects
    "Workers KV Storage Write",    # RATE, pimwell-oauth
    "Workers R2 Storage Write",    # ardi-pimwell-large
    "D1 Write",                    # HUB_DB migrations
    "Email Routing Addresses Write",
    "Account Settings Read",       # wrangler needs it to resolve the account
    "Workers Tail Read",           # wrangler tail for debugging
]
ZONE_GROUPS = [
    "Zone Read",
    "DNS Write",                   # wildcard and per-tenant mail records
    "Workers Routes Write",        # *.pimwell.com/* route and custom domains
    "Email Routing Rules Write",    # login@, signup@, agent mailboxes later
    "SSL and Certificates Write",  # custom-domain certificates
]
# Email Sending's group name is still settling while the product is in beta; matched by prefix.
ACCOUNT_GROUP_PREFIXES = ["Email Sending"]


def keychain_get(service):
    r = subprocess.run(["security", "find-generic-password", "-a", "pimwell", "-s", service, "-w"],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def keychain_put(service, secret):
    subprocess.run(["security", "delete-generic-password", "-a", "pimwell", "-s", service],
                   capture_output=True)
    subprocess.run(["security", "add-generic-password", "-a", "pimwell", "-s", service, "-w", secret],
                   check=True, capture_output=True)


def call(token, method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"success": False, "errors": [{"code": e.code, "message": str(e)}]}


def need(token, label):
    if not token:
        sys.exit(f"No {label} in the Keychain. See docs/ops/cloudflare.md.")
    return token


def zone_id(token):
    r = call(token, "GET", f"/zones?name={ZONE}")
    if not r.get("success") or not r["result"]:
        sys.exit(f"Cannot see zone {ZONE}: {r.get('errors')}")
    return r["result"][0]["id"]


def whoami():
    for service, label in [(DEPLOY, "pimwell-001"), (BOOTSTRAP, "bootstrap")]:
        t = keychain_get(service)
        if not t:
            print(f"{label}: not in Keychain")
            continue
        v = call(t, "GET", f"/accounts/{ACCOUNT_ID}/tokens/verify")
        if not v.get("success"):
            v = call(t, "GET", "/user/tokens/verify")
        r = v.get("result") or {}
        print(f"{label}: status={r.get('status')} id={r.get('id')} expires={r.get('expires_on')}")


def permission_groups(token):
    for path in (f"/accounts/{ACCOUNT_ID}/tokens/permission_groups", "/user/tokens/permission_groups"):
        r = call(token, "GET", path)
        if r.get("success"):
            return path, r["result"]
    sys.exit("The bootstrap token cannot list permission groups; it needs API Tokens Write.")


def make_deploy_token():
    boot = need(keychain_get(BOOTSTRAP), "bootstrap token")
    path, groups = permission_groups(boot)
    by_name = {g["name"]: g for g in groups}
    missing, acct, zone = [], [], []
    for n in ACCOUNT_GROUPS:
        (acct if n in by_name else missing).append(by_name.get(n, n))
    for n in ZONE_GROUPS:
        (zone if n in by_name else missing).append(by_name.get(n, n))
    for p in ACCOUNT_GROUP_PREFIXES:
        hits = [g for g in groups if g["name"].startswith(p) and ("Write" in g["name"] or "Edit" in g["name"])]
        if hits:
            acct.extend(hits)
        else:
            missing.append(p + " (write)")
    missing = [m for m in missing if isinstance(m, str)]
    if missing:
        print("Permission groups not found (left out):", ", ".join(missing))
    zid = zone_id(boot)
    expires = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365)).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = {
        "name": "pimwell-deploy",
        "expires_on": expires,
        "policies": [
            {"effect": "allow", "resources": {f"com.cloudflare.api.account.{ACCOUNT_ID}": "*"},
             "permission_groups": [{"id": g["id"]} for g in acct if isinstance(g, dict)]},
            {"effect": "allow", "resources": {f"com.cloudflare.api.account.zone.{zid}": "*"},
             "permission_groups": [{"id": g["id"]} for g in zone if isinstance(g, dict)]},
        ],
    }
    create_path = f"/accounts/{ACCOUNT_ID}/tokens" if path.startswith("/accounts") else "/user/tokens"
    r = call(boot, "POST", create_path, body)
    if not r.get("success"):
        sys.exit(f"Token creation failed: {r.get('errors')}")
    keychain_put(DEPLOY, r["result"]["value"])
    print(f"Created pimwell-deploy id={r['result']['id']} owner={'account' if 'accounts' in create_path else 'user'} expires={expires}")
    print("Account groups:", ", ".join(g["name"] for g in acct if isinstance(g, dict)))
    print(f"Zone groups ({ZONE}):", ", ".join(g["name"] for g in zone if isinstance(g, dict)))
    print("Stored in Keychain as", DEPLOY, "- now delete the bootstrap token in the dashboard and run:")
    print("  security delete-generic-password -a pimwell -s", BOOTSTRAP)


def dns_wildcard():
    t = need(keychain_get(DEPLOY), "deploy token")
    zid = zone_id(t)
    existing = call(t, "GET", f"/zones/{zid}/dns_records?name=*.{ZONE}")
    if existing.get("result"):
        rec = existing["result"][0]
        print(f"*.{ZONE} already exists: {rec['type']} {rec['content']} proxied={rec['proxied']}")
        return
    r = call(t, "POST", f"/zones/{zid}/dns_records",
             {"type": "A", "name": "*", "content": "192.0.2.1", "proxied": True, "ttl": 1,
              "comment": "pimwell tenant subdomains; traffic is served by the pimwell-hub Worker route"})
    if not r.get("success"):
        sys.exit(f"DNS create failed: {r.get('errors')}")
    print(f"Created *.{ZONE} A 192.0.2.1 proxied id={r['result']['id']}")


def audit():
    t = need(keychain_get(DEPLOY), "deploy token")
    zid = zone_id(t)
    recs = call(t, "GET", f"/zones/{zid}/dns_records?per_page=100").get("result", [])
    print(f"DNS records for {ZONE}:")
    for x in recs:
        print(f"  {x['type']:5} {x['name']:40} {str(x.get('content'))[:48]:48} proxied={x.get('proxied')}")
    routes = call(t, "GET", f"/zones/{zid}/workers/routes").get("result", [])
    print("Worker routes:")
    for x in routes:
        print(f"  {x['pattern']:30} -> {x.get('script')}")
    rules = call(t, "GET", f"/zones/{zid}/email/routing/rules").get("result", [])
    print("Email routing rules:")
    for x in rules:
        print(f"  {x.get('name')!s:20} {x.get('matchers')} -> {x.get('actions')}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "whoami"
    {"whoami": whoami, "make-deploy-token": make_deploy_token, "dns-wildcard": dns_wildcard,
     "audit": audit}.get(cmd, lambda: sys.exit(__doc__))()
