#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
METADATA_FILE="${SCRIPT_DIR}/metadata.json"
ENDPOINT="http://localhost:3000/api/ingest/ingest_paper_source"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed." >&2
  exit 1
fi

index=0
jq -c '.[]' "${METADATA_FILE}" | while IFS= read -r obj; do
  index=$((index + 1))
  echo "[$index] POST ${ENDPOINT}"
  response_file="$(mktemp)"
  trap 'rm -f "${response_file}"' EXIT

  http_status="$(curl --show-error --silent \
    --output "${response_file}" \
    --write-out "%{http_code}" \
    -X POST "${ENDPOINT}" \
    -H "Content-Type: application/json" \
    -d "${obj}")"

  if [[ "${http_status}" -lt 200 || "${http_status}" -ge 300 ]]; then
    echo "Request failed with HTTP ${http_status}" >&2
    if jq empty "${response_file}" >/dev/null 2>&1; then
      jq . "${response_file}" >&2
    else
      cat "${response_file}" >&2
      echo >&2
    fi
    rm -f "${response_file}"
    exit 1
  fi

  cat "${response_file}"
  rm -f "${response_file}"
  echo
done
