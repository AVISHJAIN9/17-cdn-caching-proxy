#!/usr/bin/env bash
set -euo pipefail

# Check for openssl; if not installed, STOP and report
if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl is required but not installed or not in PATH. STOPPING." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${REPO_ROOT}/tests/fixtures/tls"

mkdir -p "${TARGET_DIR}"

echo "Generating test-only TLS fixtures in ${TARGET_DIR}..."

# Create README.md
cat << 'EOF' > "${TARGET_DIR}/README.md"
# TEST-ONLY TLS FIXTURES

**CRITICAL NOTICE / DO NOT USE IN PRODUCTION**:
All certificates, private keys, and certificate authority bundles in this directory are strictly **TEST-ONLY** fixtures intended solely for automated local test suites.

- NEVER use these certificates or private keys in production, staging, or any public-facing environment.
- These keys are insecure test fixtures generated with local, non-secret parameters.
- Real production private keys must NEVER be committed to this repository.
EOF

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

cd "${TMP_DIR}"

# Set up minimal OpenSSL CA configuration
cat << 'EOF' > openssl.cnf
[ ca ]
default_ca = CA_default

[ CA_default ]
dir = .
database = index.txt
new_certs_dir = .
certificate = ca.crt
serial = serial
private_key = ca.key
default_md = sha256
policy = policy_any
copy_extensions = copy

[ policy_any ]
commonName = supplied
stateOrProvinceName = optional
countryName = optional
emailAddress = optional
organizationName = optional
organizationalUnitName = optional

[ req ]
distinguished_name = req_dn
x509_extensions = v3_ca

[ req_dn ]

[ v3_ca ]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,cRLSign,keyCertSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer

[ server_ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer

[ client_ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

touch index.txt
echo "01" > serial

# 1. Test Root CA
openssl req -new -x509 -newkey rsa:2048 -nodes \
  -keyout "${TARGET_DIR}/ca.key" \
  -out "${TARGET_DIR}/ca.crt" \
  -days 3650 \
  -subj "/CN=CDN Test Root CA/O=CDN Proxy Test" \
  -config openssl.cnf -extensions v3_ca

cp "${TARGET_DIR}/ca.key" ca.key
cp "${TARGET_DIR}/ca.crt" ca.crt

# 2. Server Certificate (default: localhost, 127.0.0.1, example.com, test.local)
cat << 'EOF' > server_req.cnf
[ req ]
distinguished_name = req_dn
req_extensions = req_ext
prompt = no
[ req_dn ]
CN = localhost
[ req_ext ]
subjectAltName = @alt_names
[ alt_names ]
DNS.1 = localhost
IP.1 = 127.0.0.1
DNS.2 = example.com
DNS.3 = test.local
EOF

openssl req -new -newkey rsa:2048 -nodes \
  -keyout "${TARGET_DIR}/server.key" \
  -out server.csr \
  -config server_req.cnf

openssl ca -config openssl.cnf -batch \
  -extensions server_ext \
  -extfile server_req.cnf -extensions req_ext \
  -days 3650 \
  -in server.csr \
  -out "${TARGET_DIR}/server.crt"

# 3. Server Alt Certificate (for SNI selection: alt.example.com, alt.local)
cat << 'EOF' > server_alt_req.cnf
[ req ]
distinguished_name = req_dn
req_extensions = req_ext
prompt = no
[ req_dn ]
CN = alt.example.com
[ req_ext ]
subjectAltName = @alt_names
[ alt_names ]
DNS.1 = alt.example.com
DNS.2 = alt.local
EOF

openssl req -new -newkey rsa:2048 -nodes \
  -keyout "${TARGET_DIR}/server-alt.key" \
  -out server_alt.csr \
  -config server_alt_req.cnf

openssl ca -config openssl.cnf -batch \
  -extensions server_ext \
  -extfile server_alt_req.cnf -extensions req_ext \
  -days 3650 \
  -in server_alt.csr \
  -out "${TARGET_DIR}/server-alt.crt"

# 4. Client Certificate (for mTLS client authentication)
cat << 'EOF' > client_req.cnf
[ req ]
distinguished_name = req_dn
req_extensions = req_ext
prompt = no
[ req_dn ]
CN = test-client-identity
[ req_ext ]
subjectAltName = @alt_names
[ alt_names ]
DNS.1 = test-client.local
email.1 = client@example.com
EOF

openssl req -new -newkey rsa:2048 -nodes \
  -keyout "${TARGET_DIR}/client.key" \
  -out client.csr \
  -config client_req.cnf

openssl ca -config openssl.cnf -batch \
  -extensions client_ext \
  -extfile client_req.cnf -extensions req_ext \
  -days 3650 \
  -in client.csr \
  -out "${TARGET_DIR}/client.crt"

# 5. Expired Certificate (certified in the past)
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "${TARGET_DIR}/expired.key" \
  -out expired.csr \
  -subj "/CN=expired.test.local"

openssl ca -config openssl.cnf -batch \
  -startdate 20200101000000Z -enddate 20200102000000Z \
  -in expired.csr \
  -out "${TARGET_DIR}/expired.crt"

# 6. Wrong-Host Certificate (CN & SAN for unrelated domain)
cat << 'EOF' > wrong_host_req.cnf
[ req ]
distinguished_name = req_dn
req_extensions = req_ext
prompt = no
[ req_dn ]
CN = unrelated-domain.org
[ req_ext ]
subjectAltName = @alt_names
[ alt_names ]
DNS.1 = unrelated-domain.org
EOF

openssl req -new -newkey rsa:2048 -nodes \
  -keyout "${TARGET_DIR}/wrong-host.key" \
  -out wrong_host.csr \
  -config wrong_host_req.cnf

openssl ca -config openssl.cnf -batch \
  -extensions server_ext \
  -extfile wrong_host_req.cnf -extensions req_ext \
  -days 3650 \
  -in wrong_host.csr \
  -out "${TARGET_DIR}/wrong-host.crt"

# 7. Untrusted Root CA and Untrusted Server Certificate
openssl req -new -x509 -newkey rsa:2048 -nodes \
  -keyout "${TARGET_DIR}/untrusted-ca.key" \
  -out "${TARGET_DIR}/untrusted-ca.crt" \
  -days 3650 \
  -subj "/CN=Untrusted Rogue Root CA"

openssl req -new -newkey rsa:2048 -nodes \
  -keyout "${TARGET_DIR}/untrusted-server.key" \
  -out untrusted_server.csr \
  -config server_req.cnf

openssl x509 -req -in untrusted_server.csr \
  -CA "${TARGET_DIR}/untrusted-ca.crt" \
  -CAkey "${TARGET_DIR}/untrusted-ca.key" \
  -set_serial 01 \
  -days 3650 \
  -extfile server_req.cnf -extensions req_ext \
  -out "${TARGET_DIR}/untrusted-server.crt"

# Set strict permissions on test fixtures
chmod 644 "${TARGET_DIR}"/*.crt "${TARGET_DIR}"/README.md
chmod 600 "${TARGET_DIR}"/*.key

echo "Successfully generated all test-only TLS fixtures in ${TARGET_DIR}."
