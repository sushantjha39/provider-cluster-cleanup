#!/usr/bin/env bash
#
# delete_vms_fn0qgi.sh
# Deletes k8s cluster VMs via the Apeiro Digital console API.
#
# !! DRY RUN IS ON BY DEFAULT !!
# When happy:  DRY_RUN=false ./delete_vms_fn0qgi.sh
#
# Usage:
#   export API_TOKEN="eyJhbGciOi..."          # fresh token, WITHOUT "Bearer " prefix
#   export DOMAIN="tn-zikwj3wzwu"             # optional: override domain
#   export PROJECT="default-project"          # optional: override project name
#   export PROJECT_ID="148"                   # optional: override project id
#   ./delete_vms_fn0qgi.sh                    # dry run
#   DRY_RUN=false ./delete_vms_fn0qgi.sh      # live delete
#
set -euo pipefail

BASE_URL="https://dev-console-lmu.apeiro-digital.com/api/v2.1/computes"
CE_REGION="r001"
DRY_RUN="${DRY_RUN:-true}"

# ---- Exportable config (override via env vars before running) --------------
DOMAIN="${DOMAIN:-tn-zikwj3wzwu}"
PROJECT="${PROJECT:-default-project}"
PROJECT_ID="${PROJECT_ID:-148}"

API_TOKEN="${API_TOKEN:?Set API_TOKEN first, e.g.  export API_TOKEN=\"eyJhbGci...\"  (without the 'Bearer ' prefix)}"

# ---- VM IDs to delete (all belong to the fn0qgi cluster) ------------------
VM_IDS=(
  "e09d1762-0fde-47bb-9662-b38a5e81189a"  # k8s-tn-zikwj3wzwu-fn0qgi-ansible-a10f42c6
  "4a9618fb-052d-46db-9a0c-41abf3f357a8"  # k8s-tn-zikwj3wzwu-fn0qgi-master1
  "799dae1c-e2c5-4169-97a8-cf05d26d6639"  # k8s-tn-zikwj3wzwu-fn0qgi-master2
  "b9e74862-e8c6-41f1-8b27-1e43355596d1"  # k8s-tn-zikwj3wzwu-fn0qgi-master3
  "e99f6896-87b5-4cb3-ae6c-70d157b793f5"  # k8s-tn-zikwj3wzwu-fn0qgi-worker1
  "d2a0d81e-77a0-4b2d-9fc4-5771b10be798"  # k8s-tn-zikwj3wzwu-fn0qgi-worker2
  "b28d578e-8a5a-4579-8342-1259c27ff653"  # k8s-tn-zikwj3wzwu-fn0qgi-worker3
)

echo "Mode:       $([ "$DRY_RUN" = "true" ] && echo "DRY RUN (nothing deleted)" || echo "LIVE DELETE")"
echo "Domain:     ${DOMAIN}"
echo "Project:    ${PROJECT} (id ${PROJECT_ID})"
echo "VMs:        ${#VM_IDS[@]}"
echo

for vm_id in "${VM_IDS[@]}"; do
  url="${BASE_URL}/domain/${DOMAIN}/project/${PROJECT}/computes/${vm_id}/"

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[dry-run] DELETE ${vm_id}  -> ${url}"
    continue
  fi

  echo "Deleting ${vm_id}"
  http_status=$(curl --silent --show-error --output /tmp/delete_vm_response.json \
    --write-out '%{http_code}' \
    --url "${url}" \
    -X 'DELETE' \
    -H 'Origin: https://dev-console-lmu.apeiro-digital.com' \
    -H 'Referer: https://dev-console-lmu.apeiro-digital.com/compute/virtual-machines' \
    -H 'accept: application/json' \
    -H "authorization: Bearer ${API_TOKEN}" \
    -H "ce-region: ${CE_REGION}" \
    -H "external-project: ${PROJECT}" \
    -H "organisation-name: ${DOMAIN}" \
    -H "project-id: ${PROJECT_ID}" \
    -H "project-name: ${PROJECT}" \
    -H 'sec-ch-ua-platform: "Windows"' \
    -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0')

  if [[ "${http_status}" =~ ^2 ]]; then
    echo "  -> OK (HTTP ${http_status})"
  else
    echo "  -> FAILED (HTTP ${http_status}). Response:"; cat /tmp/delete_vm_response.json; echo
  fi
  sleep 1
done

echo "Done."
