#!/bin/bash
# Re-issue the Infisical machine-identity token stored in ~/credentials/infisical.env.
#
# Use when the token has expired (Infisical logs show "TokenExpiredError: jwt expired"
# and every script that reads secrets gets empty values). Logs in as the instance admin
# (credentials already in infisical.env), mints a new token on the machine identity, and
# only installs it if (a) its JWT expiry is >5 years out and (b) a test fetch succeeds.
# The old file is kept as infisical.env.expired-<date>. Prints NO secret values.
#
# Background: docs/INFISICAL_UPGRADE_RUNBOOK.md, scripts/setup-infisical.sh (the 10yr-TTL
# fix landed after this host's original token was minted, so this host's token was only
# valid for 90 days: 2026-08-02 -> 2026-10-31).
set -uo pipefail

ENVF="${HOME}/credentials/infisical.env"
set -a
# shellcheck disable=SC1090
. "${ENVF}"
set +a

# The machine identity ("Instance Admin Identity"): look it up rather than hardcode.
IDENTITY_ID=$(docker exec infisical-db psql -U infisical -d infisical -At \
    -c "select id from identities where name='Instance Admin Identity' limit 1")
[ -n "${IDENTITY_ID}" ] || { echo "FAIL: could not find the machine identity id"; exit 1; }

ORG_ID=$(docker exec infisical-db psql -U infisical -d infisical -At \
    -c "select \"orgId\" from identities where id='${IDENTITY_ID}'")
[ -n "${ORG_ID}" ] || { echo "FAIL: could not find the organization id"; exit 1; }

LOGIN_ERR=$(mktemp)
USER_JWT=$(infisical login --method=user --email="${INFISICAL_ADMIN_EMAIL}" \
    --password="${INFISICAL_ADMIN_PASSWORD}" --domain="${INFISICAL_API_URL}" \
    --organization-id="${ORG_ID}" --plain --silent 2> "${LOGIN_ERR}") || true
if [ -z "${USER_JWT}" ]; then
    echo "FAIL: admin login returned nothing. CLI said (password/tokens stripped):"
    sed -e "s/${INFISICAL_ADMIN_PASSWORD}/<password>/g" "${LOGIN_ERR}" | head -15
    rm -f "${LOGIN_ERR}"
    exit 1
fi
rm -f "${LOGIN_ERR}"
echo "admin login ok"

RESP=$(curl -s -X POST "${INFISICAL_API_URL}/api/v1/auth/token-auth/identities/${IDENTITY_ID}/tokens" \
    -H "Authorization: Bearer ${USER_JWT}" -H "Content-Type: application/json" \
    -d '{"name":"cron-scripts-token"}')
NEW=$(printf '%s' "${RESP}" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["accessToken"])
except Exception: pass')
[ -n "${NEW}" ] || { echo "FAIL: no accessToken in response"; exit 1; }

DAYS=$(python3 - "${NEW}" <<'PY'
import sys, json, base64, time, datetime
t = sys.argv[1]
p = t.split('.')[1]
p += '=' * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
exp = c.get('exp')
if exp:
    print(int((exp - time.time()) / 86400))
    sys.stderr.write("new token expires %s\n" % datetime.datetime.fromtimestamp(exp))
else:
    print(-1)
    sys.stderr.write("new token has NO exp claim\n")
PY
)
echo "days until expiry: ${DAYS}"
if [ "${DAYS}" -ne -1 ] && [ "${DAYS}" -lt 1825 ]; then
    echo "STOP: new token expires in under 5 years; NOT installing it"
    exit 2
fi

CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    "${INFISICAL_API_URL}/api/v3/secrets/raw/BORG_PASSPHRASE?workspaceId=${INFISICAL_PROJECT_ID}&environment=prod&secretPath=/borgbackup" \
    -H "Authorization: Bearer ${NEW}")
echo "new token test fetch: http ${CODE}"
[ "${CODE}" = "200" ] || { echo "STOP: new token rejected; NOT installing it"; exit 3; }

cp -p "${ENVF}" "${ENVF}.expired-$(date +%F)"
python3 - "${ENVF}" "${NEW}" <<'PY'
import sys, os, re
f, new = sys.argv[1], sys.argv[2]
s = open(f).read()
s2 = re.sub(r'^INFISICAL_TOKEN=.*$', 'INFISICAL_TOKEN=' + new, s, flags=re.M)
assert s2 != s
tmp = f + '.new'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, s2.encode())
os.close(fd)
os.replace(tmp, f)
PY
chmod 600 "${ENVF}"
echo "installed. Old file kept at ${ENVF}.expired-$(date +%F) (delete when satisfied)."
