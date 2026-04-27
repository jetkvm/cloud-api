#!/usr/bin/env bash

set -uo pipefail

LOCAL_BASE="${LOCAL_BASE:-http://localhost:3000}"
PROD_BASE="${PROD_BASE:-https://api.jetkvm.com}"

DEFAULT_DEVICE_IDS=("compare-device-1")
DEFAULT_SKUS=("__omit__" "jetkvm-v2" "jetkvm-2" "jetkvm-3")
TRISTATE_VALUES=("__omit__" "false" "true")

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS_COUNT=0
FAIL_COUNT=0
ACCEPTED_COUNT=0
CASE_COUNT=0
CASE_INDEX=0
TOTAL_CASES=0
PROGRESS_WIDTH=40

print_usage() {
  cat <<'EOF'
Usage: scripts/compare-releases.sh [device_id ...]

Compares release endpoint responses between:
  - local API
  - api.jetkvm.com

Defaults:
  LOCAL_BASE=http://localhost:3000
  PROD_BASE=https://api.jetkvm.com
  device_ids=(compare-device-1)

Environment overrides:
  LOCAL_BASE              Override local host
  PROD_BASE               Override production host
  CURL_TIMEOUT            Curl max time in seconds (default: 30)
  CURL_CONNECT_TIMEOUT    Curl connect timeout in seconds (default: 10)
  FAIL_FAST               Stop after first failed case (default: true)

Examples:
  scripts/compare-releases.sh
  scripts/compare-releases.sh device-a device-b
  LOCAL_BASE=http://localhost:3001 PROD_BASE=https://api.jetkvm.com scripts/compare-releases.sh
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_usage
  exit 0
fi

if (($# > 0)); then
  DEVICE_IDS=("$@")
else
  DEVICE_IDS=("${DEFAULT_DEVICE_IDS[@]}")
fi

CURL_TIMEOUT="${CURL_TIMEOUT:-30}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-10}"
MAX_PARALLEL="${MAX_PARALLEL:-5}"
RETRY_COUNT="${RETRY_COUNT:-2}"
RETRY_DELAY_SECONDS="${RETRY_DELAY_SECONDS:-1}"
FAIL_FAST="${FAIL_FAST:-true}"

log() {
  printf '%s\n' "$*"
}

render_progress() {
  local completed="$1"
  local total="$2"
  local width="${3:-$PROGRESS_WIDTH}"
  local filled=0
  local empty=0

  if (( total > 0 )); then
    filled=$(( completed * width / total ))
  fi
  empty=$(( width - filled ))

  printf '%*s' "$filled" '' | tr ' ' '#'
  printf '%*s' "$empty" ''
}

urlencode() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import quote

print(quote(sys.argv[1], safe=""))
PY
}

join_query() {
  local -n query_keys_ref=$1
  local -n query_values_ref=$2
  local query=""
  local i key value encoded

  for i in "${!query_keys_ref[@]}"; do
    key="${query_keys_ref[$i]}"
    value="${query_values_ref[$i]}"
    [[ "$value" == "__omit__" ]] && continue
    encoded="$(urlencode "$value")"
    if [[ -n "$query" ]]; then
      query+="&"
    fi
    query+="${key}=${encoded}"
  done

  printf '%s' "$query"
}

header_value() {
  local file="$1"
  local name="$2"
  python3 - "$file" "$name" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
name = sys.argv[2].lower()
value = ""
for raw_line in path.read_text(errors="replace").splitlines():
    line = raw_line.strip()
    if not line or ":" not in line:
        continue
    key, candidate = line.split(":", 1)
    if key.lower() == name:
        value = candidate.strip()
print(value)
PY
}

normalize_body() {
  local body_file="$1"
  local normalized_file="$2"
  if [[ ! -f "$body_file" ]]; then
    : >"$normalized_file"
    return
  fi
  python3 - "$body_file" "$normalized_file" <<'PY'
import json
import sys
from pathlib import Path

body_path = Path(sys.argv[1])
normalized_path = Path(sys.argv[2])
body = body_path.read_text(errors="replace")

try:
    parsed = json.loads(body)
except Exception:
    normalized_path.write_text(body)
else:
    def scrub(value):
        if isinstance(value, dict):
            return {
                key: scrub(child)
                for key, child in value.items()
                if not key.endswith("CachedAt")
            }
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return value

    normalized_path.write_text(json.dumps(scrub(parsed), indent=2, sort_keys=True) + "\n")
PY
}

summarize_body_mismatch() {
  local left_file="$1"
  local right_file="$2"
  python3 - "$left_file" "$right_file" <<'PY'
import json
import sys
from pathlib import Path

left_path = Path(sys.argv[1])
right_path = Path(sys.argv[2])

def load(path):
    try:
        return json.loads(path.read_text(errors="replace"))
    except Exception:
        return path.read_text(errors="replace")

left = load(left_path)
right = load(right_path)

def walk(a, b, path="$"):
    if type(a) != type(b):
        return path, a, b
    if isinstance(a, dict):
        keys = sorted(set(a) | set(b))
        for key in keys:
            if key not in a:
                return f"{path}.{key}", "<missing>", b[key]
            if key not in b:
                return f"{path}.{key}", a[key], "<missing>"
            result = walk(a[key], b[key], f"{path}.{key}")
            if result is not None:
                return result
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}.length", len(a), len(b)
        for idx, (av, bv) in enumerate(zip(a, b)):
            result = walk(av, bv, f"{path}[{idx}]")
            if result is not None:
                return result
        return None
    if a != b:
        return path, a, b
    return None

result = walk(left, right)
if result is None:
    print("values differ")
else:
    path, left_value, right_value = result
    print(f"path={path}")
    print(f"local={json.dumps(left_value, sort_keys=True)}")
    print(f"prod={json.dumps(right_value, sort_keys=True)}")
PY
}

body_diff_is_version_only_not_found() {
  local left_file="$1"
  local right_file="$2"
  python3 - "$left_file" "$right_file" <<'PY'
import json
import re
import sys
from pathlib import Path

try:
    left = json.loads(Path(sys.argv[1]).read_text(errors="replace"))
    right = json.loads(Path(sys.argv[2]).read_text(errors="replace"))
except Exception:
    raise SystemExit(1)

if not (isinstance(left, dict) and isinstance(right, dict)):
    raise SystemExit(1)

if left.get("name") != "NotFoundError" or right.get("name") != "NotFoundError":
    raise SystemExit(1)

left_keys = set(left.keys())
right_keys = set(right.keys())
if left_keys != {"name", "message"} or right_keys != {"name", "message"}:
    raise SystemExit(1)

version_pattern = re.compile(
    r'^(Version )(.+?)( predates SKU support and cannot serve SKU "[^"]+")$'
)

left_message = left.get("message", "")
right_message = right.get("message", "")

left_normalized = version_pattern.sub(r"\1<version>\3", left_message)
right_normalized = version_pattern.sub(r"\1<version>\3", right_message)

if left_normalized == right_normalized:
    raise SystemExit(0)

raise SystemExit(1)
PY
}

is_accepted_deviation() {
  local query="$1"
  local left_prefix="$2"
  local right_prefix="$3"
  python3 - "$query" "${left_prefix}.meta" "${right_prefix}.meta" "${left_prefix}.normalized" "${right_prefix}.normalized" <<'PY'
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs

query, left_meta_path, right_meta_path, left_body_path, right_body_path = sys.argv[1:]
params = parse_qs(query, keep_blank_values=True)

def one(name):
    values = params.get(name, [])
    return values[0] if values else None

def parse_meta(path):
    data = {}
    for line in Path(path).read_text(errors="replace").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            data[key] = value
    return data

def load_json(path):
    try:
        return json.loads(Path(path).read_text(errors="replace"))
    except Exception:
        return None

left_meta = parse_meta(left_meta_path)
right_meta = parse_meta(right_meta_path)
left_body = load_json(left_body_path)
right_body = load_json(right_body_path)

# Accepted behavior change:
# Stable requests with prerelease/dev version constraints are DB-only locally.
# Production still resolves those directly from S3. Local 404 vs prod 200 is expected.
if one("prerelease") not in (None, "false"):
    raise SystemExit(1)

constrained_versions = [one("appVersion"), one("systemVersion")]
has_dev_constraint = any(value and "-" in value for value in constrained_versions)
if not has_dev_constraint:
    raise SystemExit(1)

if left_meta.get("http_code") != "404" or right_meta.get("http_code") != "200":
    raise SystemExit(1)

if not isinstance(left_body, dict) or left_body.get("name") != "NotFoundError":
    raise SystemExit(1)

if not isinstance(right_body, dict) or not right_body.get("appVersion") or not right_body.get("systemVersion"):
    raise SystemExit(1)

raise SystemExit(0)
PY
}

curl_capture() {
  local base_url="$1"
  local path="$2"
  local query="$3"
  local prefix="$4"
  local url="${base_url}${path}"
  local headers_file="${prefix}.headers"
  local body_file="${prefix}.body"
  local meta_file="${prefix}.meta"
  local stderr_file="${prefix}.stderr"
  local exit_file="${prefix}.exit"
  local attempt=0
  local curl_exit=0
  local http_code=""

  if [[ -n "$query" ]]; then
    url="${url}?${query}"
  fi

  while :; do
    : >"$headers_file"
    : >"$body_file"
    : >"$meta_file"
    : >"$stderr_file"

    curl_exit=0
    curl \
      --silent \
      --show-error \
      --connect-timeout "$CURL_CONNECT_TIMEOUT" \
      --max-time "$CURL_TIMEOUT" \
      --dump-header "$headers_file" \
      --output "$body_file" \
      --write-out "http_code=%{http_code}\ncontent_type=%{content_type}\n" \
      "$url" >"$meta_file" 2>"$stderr_file" || curl_exit=$?

    printf '%s\n' "$curl_exit" >"$exit_file"
    http_code="$(sed -n 's/^http_code=//p' "$meta_file")"

    if (( curl_exit == 0 )) && [[ ! "$http_code" =~ ^52[0-9]$ ]]; then
      break
    fi

    if (( attempt >= RETRY_COUNT )); then
      break
    fi

    attempt=$((attempt + 1))
    sleep "$RETRY_DELAY_SECONDS"
  done
}

compare_scalar_files() {
  local label="$1"
  local left_file="$2"
  local right_file="$3"
  local left_value right_value

  left_value="$(tr -d '\r' <"$left_file")"
  right_value="$(tr -d '\r' <"$right_file")"
  if [[ "$left_value" == "$right_value" ]]; then
    return 1
  fi

  printf '%s\n' "$label"
  printf '    local=%s\n' "${left_value:-<empty>}"
  printf '    prod=%s\n' "${right_value:-<empty>}"
  return 0
}

summarize_meta_mismatch() {
  local left_file="$1"
  local right_file="$2"
  python3 - "$left_file" "$right_file" <<'PY'
import sys
from pathlib import Path

def parse(path_str):
    data = {}
    for line in Path(path_str).read_text(errors="replace").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key] = value
    return data

left = parse(sys.argv[1])
right = parse(sys.argv[2])
keys = sorted(set(left) | set(right))
for key in keys:
    if left.get(key) != right.get(key):
        print(f"{key}")
        print(f"local={left.get(key, '<missing>')}")
        print(f"prod={right.get(key, '<missing>')}")
PY
}

write_case_result() {
  local result_file="$1"
  local case_name="$2"
  local path="$3"
  local query="$4"
  local left_prefix="$5"
  local right_prefix="$6"
  local left_norm="${left_prefix}.normalized"
  local right_norm="${right_prefix}.normalized"
  local left_location right_location
  local failed=0
  local details=""
  local mismatch_count=0
  local output=""
  local accepted_reason=""

  normalize_body "${left_prefix}.body" "$left_norm"
  normalize_body "${right_prefix}.body" "$right_norm"

  if output="$(compare_scalar_files "exit-code mismatch" "${left_prefix}.exit" "${right_prefix}.exit")"; then
    mismatch_count=$((mismatch_count + 1))
    details+="$output"$'\n'
    failed=1
  fi

  if output="$(summarize_meta_mismatch "${left_prefix}.meta" "${right_prefix}.meta")" && [[ -n "$output" ]]; then
    mismatch_count=$((mismatch_count + 1))
    details+=$'  response-meta mismatch\n'
    details+="$(printf '%s\n' "$output" | sed 's/^/    /')"$'\n'
    failed=1
  fi

  left_location="$(header_value "${left_prefix}.headers" "location")"
  right_location="$(header_value "${right_prefix}.headers" "location")"
  if [[ "$left_location" != "$right_location" ]]; then
    mismatch_count=$((mismatch_count + 1))
    details+=$'  location mismatch\n'
    details+="    local=${left_location:-<none>}"$'\n'
    details+="    prod=${right_location:-<none>}"$'\n'
    failed=1
  fi

  if [[ -s "${left_prefix}.body" || -s "${right_prefix}.body" ]]; then
    if ! cmp -s "$left_norm" "$right_norm"; then
      if body_diff_is_version_only_not_found "$left_norm" "$right_norm"; then
        :
      else
        mismatch_count=$((mismatch_count + 1))
        details+=$'  body mismatch\n'
        details+="$(summarize_body_mismatch "$left_norm" "$right_norm" | sed 's/^/    /')"$'\n'
        failed=1
      fi
    fi
  fi

  if (( failed == 1 )) && is_accepted_deviation "$query" "$left_prefix" "$right_prefix"; then
    failed=0
    accepted_reason="stable dev/prerelease version constraints are DB-only locally"
    details=""
    mismatch_count=0
  fi

  {
    printf 'status=%s\n' "$([[ $failed -eq 0 ]] && { [[ -n "$accepted_reason" ]] && printf accepted || printf pass; } || printf fail)"
    printf 'case_name=%s\n' "$case_name"
    printf 'path=%s\n' "$path"
    printf 'query=%s\n' "$query"
    printf 'accepted_reason=%s\n' "$accepted_reason"
    printf 'mismatch_count=%s\n' "$mismatch_count"
    printf 'details<<__DETAILS__\n%s__DETAILS__\n' "$details"
    printf 'local_stderr<<__STDERR__\n%s__STDERR__\n' "$(tr '\n' ' ' <"${left_prefix}.stderr")"
    printf 'prod_stderr<<__STDERR__\n%s__STDERR__\n' "$(tr '\n' ' ' <"${right_prefix}.stderr")"
  } >"$result_file"
}

run_case_worker() {
  local case_name="$1"
  local path="$2"
  local query="$3"
  local safe_case="$4"
  local result_file="$5"

  local local_prefix="$TMP_DIR/${safe_case}.local"
  local prod_prefix="$TMP_DIR/${safe_case}.prod"

  curl_capture "$LOCAL_BASE" "$path" "$query" "$local_prefix" &
  local local_pid=$!
  curl_capture "$PROD_BASE" "$path" "$query" "$prod_prefix" &
  local prod_pid=$!
  wait "$local_pid"
  wait "$prod_pid"

  write_case_result "$result_file" "$case_name" "$path" "$query" "$local_prefix" "$prod_prefix"
}

print_case_result() {
  local result_file="$1"
  local progress_bar
  local status case_name path query accepted_reason mismatch_count details local_stderr prod_stderr

  progress_bar="$(render_progress "$CASE_INDEX" "$TOTAL_CASES")"
  status="$(sed -n 's/^status=//p' "$result_file")"
  case_name="$(sed -n 's/^case_name=//p' "$result_file")"
  path="$(sed -n 's/^path=//p' "$result_file")"
  query="$(sed -n 's/^query=//p' "$result_file")"
  accepted_reason="$(sed -n 's/^accepted_reason=//p' "$result_file")"
  mismatch_count="$(sed -n 's/^mismatch_count=//p' "$result_file")"
  details="$(awk '/^details<<__DETAILS__/{flag=1;next}/^__DETAILS__$/{flag=0}flag' "$result_file")"
  local_stderr="$(awk '/^local_stderr<<__STDERR__/{flag=1;next}/^__STDERR__$/{if(flag){flag=0; exit}}flag' "$result_file")"
  prod_stderr="$(awk 'found && /^__STDERR__$/ {exit} /^prod_stderr<<__STDERR__$/ {found=1; next} found {print}' "$result_file")"

  if [[ "$status" == "pass" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '\r[%s] %4d/%-4d | pass:%d fail:%d' \
      "$progress_bar" "$CASE_INDEX" "$TOTAL_CASES" "$PASS_COUNT" "$FAIL_COUNT"
    if (( CASE_INDEX == TOTAL_CASES )); then
      printf '\n'
    fi
  elif [[ "$status" == "accepted" ]]; then
    ACCEPTED_COUNT=$((ACCEPTED_COUNT + 1))
    printf '\r\033[K'
    printf '[%s] %4d/%-4d | pass:%d accepted:%d fail:%d\n' \
      "$progress_bar" "$CASE_INDEX" "$TOTAL_CASES" "$PASS_COUNT" "$ACCEPTED_COUNT" "$FAIL_COUNT"
    printf '  ACCEPT %s\n' "$case_name"
    printf '  %s%s%s\n' "$path" "${query:+?$query}" ""
    printf '  %s\n' "$accepted_reason"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '\r\033[K'
    printf '[%s] %4d/%-4d | pass:%d fail:%d\n' \
      "$progress_bar" "$CASE_INDEX" "$TOTAL_CASES" "$PASS_COUNT" "$FAIL_COUNT"
    printf '  FAIL %s\n' "$case_name"
    printf '  %s%s%s\n' "$path" "${query:+?$query}" ""
    printf '%s' "$details"
    if [[ -n "$local_stderr" || -n "$prod_stderr" ]]; then
      printf '  stderr\n'
      printf '    local=%s\n' "$local_stderr"
      printf '    prod=%s\n' "$prod_stderr"
    fi
    if [[ "${mismatch_count:-0}" == "0" ]]; then
      printf '  mismatch detected\n'
    fi
  fi
}

stop_requested() {
  [[ "$FAIL_FAST" != "false" && "$FAIL_COUNT" -gt 0 ]]
}

wait_for_one_job() {
  local pid done_pid result_file
  while :; do
    for pid in "${!JOB_RESULT_FILES[@]}"; do
      if ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid" || true
        done_pid="$pid"
        result_file="${JOB_RESULT_FILES[$pid]}"
        unset "JOB_RESULT_FILES[$pid]"
        CASE_INDEX=$((CASE_INDEX + 1))
        print_case_result "$result_file"
        rm -f "$result_file"
        return
      fi
    done
    sleep 0.05
  done
}

drain_jobs() {
  while ((${#JOB_RESULT_FILES[@]} > 0)); do
    wait_for_one_job
    if stop_requested; then
      for pid in "${!JOB_RESULT_FILES[@]}"; do
        kill "$pid" 2>/dev/null || true
      done
      JOB_RESULT_FILES=()
      break
    fi
  done
}

extract_versions() {
  local device_id="$1"
  local prerelease="$2"
  local sku="$3"
  local prefix="$4"

  local query_keys=("deviceId" "prerelease" "sku")
  local query_values=("$device_id" "$prerelease" "$sku")
  local query
  query="$(join_query query_keys query_values)"

  curl_capture "$PROD_BASE" "/releases" "$query" "$prefix"

  python3 - "$prefix.body" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    payload = json.loads(path.read_text(errors="replace"))
except Exception:
    print("")
    print("")
    raise SystemExit(0)

print(payload.get("appVersion", ""))
print(payload.get("systemVersion", ""))
PY
}

build_value_set() {
  local exact_version="$1"
  local prerelease_version="$2"
  local values=("__omit__" "*")

  if [[ -n "$exact_version" ]]; then
    values+=("$exact_version")
  fi
  if [[ -n "$prerelease_version" && "$prerelease_version" != "$exact_version" ]]; then
    values+=("$prerelease_version")
  fi

  printf '%s\n' "${values[@]}" | awk '!seen[$0]++'
}

run_case() {
  local case_name="$1"
  local path="$2"
  local -n case_keys_ref=$3
  local -n case_values_ref=$4
  local query

  CASE_COUNT=$((CASE_COUNT + 1))
  query="$(join_query case_keys_ref case_values_ref)"

  local safe_case
  safe_case="$(printf '%s' "$case_name" | tr ' /?=&' '_____')"
  local result_file="$TMP_DIR/${safe_case}.result"

  run_case_worker "$case_name" "$path" "$query" "$safe_case" "$result_file" &
  JOB_RESULT_FILES[$!]="$result_file"

  while ((${#JOB_RESULT_FILES[@]} >= MAX_PARALLEL)); do
    wait_for_one_job
    if stop_requested; then
      return
    fi
  done
}

log "Comparing release endpoints"
log "  local:   $LOCAL_BASE"
log "  prod:    $PROD_BASE"
log "  deviceIds: ${DEVICE_IDS[*]}"

mapfile -t stable_versions < <(extract_versions "${DEVICE_IDS[0]}" "__omit__" "__omit__" "$TMP_DIR/baseline-stable")
mapfile -t prerelease_versions < <(extract_versions "${DEVICE_IDS[0]}" "true" "__omit__" "$TMP_DIR/baseline-prerelease")

STABLE_APP_VERSION="${stable_versions[0]:-}"
STABLE_SYSTEM_VERSION="${stable_versions[1]:-}"
PRERELEASE_APP_VERSION="${prerelease_versions[0]:-}"
PRERELEASE_SYSTEM_VERSION="${prerelease_versions[1]:-}"

mapfile -t APP_VERSION_VALUES < <(build_value_set "$STABLE_APP_VERSION" "$PRERELEASE_APP_VERSION")
mapfile -t SYSTEM_VERSION_VALUES < <(build_value_set "$STABLE_SYSTEM_VERSION" "$PRERELEASE_SYSTEM_VERSION")

TOTAL_CASES=$(( ${#DEVICE_IDS[@]} * ${#TRISTATE_VALUES[@]} * ${#TRISTATE_VALUES[@]} * ${#APP_VERSION_VALUES[@]} * ${#SYSTEM_VERSION_VALUES[@]} * ${#DEFAULT_SKUS[@]} + ${#TRISTATE_VALUES[@]} * ${#DEFAULT_SKUS[@]} * 2 ))
declare -A JOB_RESULT_FILES=()
log "  total cases: $TOTAL_CASES"
log "  parallel: $MAX_PARALLEL"
log "  failFast: $FAIL_FAST"
log

for device_id in "${DEVICE_IDS[@]}"; do
  for prerelease in "${TRISTATE_VALUES[@]}"; do
    for force_update in "${TRISTATE_VALUES[@]}"; do
      for app_version in "${APP_VERSION_VALUES[@]}"; do
        for system_version in "${SYSTEM_VERSION_VALUES[@]}"; do
          for sku in "${DEFAULT_SKUS[@]}"; do
            if stop_requested; then
              break 6
            fi
            query_keys=("deviceId" "prerelease" "forceUpdate" "appVersion" "systemVersion" "sku")
            query_values=("$device_id" "$prerelease" "$force_update" "$app_version" "$system_version" "$sku")
            run_case \
              "GET /releases deviceId=$device_id prerelease=$prerelease forceUpdate=$force_update appVersion=$app_version systemVersion=$system_version sku=$sku" \
              "/releases" \
              query_keys \
              query_values
          done
        done
      done
    done
  done
done

for prerelease in "${TRISTATE_VALUES[@]}"; do
  for sku in "${DEFAULT_SKUS[@]}"; do
    if stop_requested; then
      break 2
    fi
    query_keys=("prerelease" "sku")
    query_values=("$prerelease" "$sku")
    run_case \
      "GET /releases/app/latest prerelease=$prerelease sku=$sku" \
      "/releases/app/latest" \
      query_keys \
      query_values
    run_case \
      "GET /releases/system_recovery/latest prerelease=$prerelease sku=$sku" \
      "/releases/system_recovery/latest" \
      query_keys \
      query_values
  done
done

drain_jobs

log
log "Summary"
log "  cases:  $CASE_COUNT"
log "  pass:   $PASS_COUNT"
log "  accept: $ACCEPTED_COUNT"
log "  fail:   $FAIL_COUNT"

if ((FAIL_COUNT > 0)); then
  exit 1
fi
