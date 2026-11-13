#!/usr/bin/env bash
# Tests for scripts/mac-runner.sh. Fake gh, curl, sudo, pgrep, xcodebuild and svc.sh go first on PATH;
# the fake GitHub keeps the variable and the runner in files, and every call is logged.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/mac-runner.sh"
FAILURES=0
PASSED=0

check() { # name, condition-exit-status
  if [ "$2" = 0 ]; then
    PASSED=$((PASSED + 1))
  else
    FAILURES=$((FAILURES + 1))
    echo "not ok: $1"
  fi
}

# A fresh fake Mac and GitHub for each scenario.
setup() {
  FAKE=$(mktemp -d)
  mkdir -p "$FAKE/bin" "$FAKE/runner" "$FAKE/xcode/Xcode_26.0.app/Contents/Developer"
  : > "$FAKE/calls"
  cat > "$FAKE/runner/svc.sh" <<'SVC'
#!/usr/bin/env bash
echo "svc $1" >> "$FAKE_DIR/calls"
SVC
  chmod +x "$FAKE/runner/svc.sh"

  cat > "$FAKE/bin/gh" <<'GH'
#!/usr/bin/env bash
# Only `gh auth token` is used by the script.
if [ "$FAKE_GH_LOGGED" = 1 ]; then echo caller-token; else exit 1; fi
GH

  cat > "$FAKE/bin/pgrep" <<'PG'
#!/usr/bin/env bash
[ "$FAKE_SERVICE" = running ]
PG

  cat > "$FAKE/bin/sudo" <<'SUDO'
#!/usr/bin/env bash
echo "sudo $*" >> "$FAKE_DIR/calls"
if [ "$1" = -u ]; then shift 2; fi
exec "$@"
SUDO

  cat > "$FAKE/bin/xcodebuild" <<'XB'
#!/usr/bin/env bash
echo "Xcode 26.0"
XB

  # The fake GitHub. Token "caller-token" works only when FAKE_CALLER_OK=1; "file-token" always works.
  cat > "$FAKE/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -u
out="" ; method=GET ; data=""
while [ $# -gt 1 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -X) method=$2; shift ;;
    --data-binary) data=$2; shift ;;
  esac
  shift
done
url=$1
path=${url#https://api.github.com/}
header=$(cat)
token=${header#Authorization: Bearer }
token=${token%$'\n'}
who=none
case "$token" in
  "") code=401 ;;
  caller-token) who=caller; if [ "$FAKE_CALLER_OK" = 1 ]; then code=OK; else code=403; fi ;;
  file-token) who=stored; code=OK ;;
  *) code=401 ;;
esac
polls=$(cat "$FAKE_DIR/polls" 2> /dev/null || echo 0)
echo "$method $path $who polls=$polls" >> "$FAKE_DIR/calls"
body='{}'
if [ "$code" != OK ]; then
  body='{"message":"denied"}'; status=$code
else
  status=200
  case "$method $path" in
    "GET repos/dashnash/stacks")
      body=$(jq -n --argjson a "$FAKE_ADMIN" '{permissions: {admin: $a}}') ;;
    "GET repos/dashnash/stacks/actions/runners"*)
      echo $((polls + 1)) > "$FAKE_DIR/polls"
      if [ "$((polls + 1))" -ge "${FAKE_ONLINE_AFTER:-0}" ]; then st=online; else st=offline; fi
      busy=$(cat "$FAKE_DIR/busy")
      body=$(jq -n --arg s "$st" --argjson b "$busy" '{runners: [{status: $s, busy: $b, labels: [{name: "self-hosted"}, {name: "stacks-ios"}]}]}') ;;
    "GET repos/dashnash/stacks/actions/variables/MACOS_RUNNER")
      if [ -f "$FAKE_DIR/var" ]; then body=$(jq -n --arg v "$(cat "$FAKE_DIR/var")" '{value: $v}'); else status=404; fi ;;
    "PATCH repos/dashnash/stacks/actions/variables/MACOS_RUNNER")
      if [ -f "$FAKE_DIR/var" ]; then printf '%s' "$(jq -r .value <<< "$data")" > "$FAKE_DIR/var"; status=204; else status=404; fi ;;
    "POST repos/dashnash/stacks/actions/variables")
      printf '%s' "$(jq -r .value <<< "$data")" > "$FAKE_DIR/var"; status=201 ;;
    "DELETE repos/dashnash/stacks/actions/variables/MACOS_RUNNER")
      if [ -f "$FAKE_DIR/var" ]; then rm -f "$FAKE_DIR/var"; status=204; else status=404; fi ;;
    *) status=404 ;;
  esac
fi
[ -n "$out" ] && printf '%s' "$body" > "$out"
echo "$status"
CURL
  chmod +x "$FAKE"/bin/*

  echo 0 > "$FAKE/polls"
  echo false > "$FAKE/busy"
  export FAKE_DIR="$FAKE" PATH="$FAKE/bin:$PATH"
  export STACKS_RUNNER_DIR="$FAKE/runner" STACKS_TOKEN_FILE="$FAKE/token" STACKS_CI_HOME="$FAKE/ci"
  export STACKS_XCODE_DIR="$FAKE/xcode" STACKS_ONLINE_WAIT=2 STACKS_ONLINE_POLL=1
  export STACKS_OFF_WAIT=2 STACKS_BUSY_POLL=1
  export FAKE_GH_LOGGED=1 FAKE_CALLER_OK=1 FAKE_ADMIN=true FAKE_SERVICE=stopped FAKE_ONLINE_AFTER=0
  echo file-token > "$FAKE/token"
}

teardown() { rm -rf "$FAKE"; }

run() { # run the script with arguments; sets RC and OUT
  set +e
  OUT=$(bash "$SCRIPT" "$@" < /dev/null 2>&1)
  RC=$?
  set -e
}

calls() { cat "$FAKE/calls"; }
variable() { if [ -f "$FAKE/var" ]; then cat "$FAKE/var"; else echo "(unset)"; fi; }

# --- status

setup
run status
check "status: unset routing and runner online is consistent (exit 0)" "$([ "$RC" = 0 ] && echo 0 || echo 1)"
check "status: says the jobs go to macos-26" "$(grep -q 'unset' <<< "$OUT" && echo 0 || echo 1)"
teardown

setup
echo '["self-hosted","macOS","ARM64","stacks-ios"]' > "$FAKE/var"
FAKE_ONLINE_AFTER=99
run status
check "status: exit 2 when routing points here but the runner is offline" "$([ "$RC" = 2 ] && echo 0 || echo 1)"
check "status: warns about the mismatch" "$(grep -q WARNING <<< "$OUT" && echo 0 || echo 1)"
teardown

# --- on

setup
FAKE_ADMIN=false
run on
check "on: refuses without admin rights" "$([ "$RC" != 0 ] && echo 0 || echo 1)"
check "on: the variable stays unset" "$([ "$(variable)" = "(unset)" ] && echo 0 || echo 1)"
teardown

setup
FAKE_ONLINE_AFTER=2
run on
check "on: succeeds once the runner is online" "$([ "$RC" = 0 ] && echo 0 || echo 1)"
check "on: starts the service when it is stopped" "$(grep -q '^svc start' "$FAKE/calls" && echo 0 || echo 1)"
check "on: sets the variable to the self-hosted labels" "$([ "$(variable)" = '["self-hosted","macOS","ARM64","stacks-ios"]' ] && echo 0 || echo 1)"
check "on: sets the variable only after GitHub saw the runner online (poll 2)" "$(grep -E 'PATCH|POST' "$FAKE/calls" | grep -q 'polls=[2-9]' && echo 0 || echo 1)"
teardown

setup
FAKE_ONLINE_AFTER=99
run on
check "on: fails when the runner never comes online" "$([ "$RC" != 0 ] && echo 0 || echo 1)"
check "on: leaves the variable alone when the runner never comes online" "$([ "$(variable)" = "(unset)" ] && echo 0 || echo 1)"
teardown

# --- off

setup
echo '["self-hosted","macOS","ARM64","stacks-ios"]' > "$FAKE/var"
FAKE_GH_LOGGED=0
run off
check "off: falls back to the stored token when gh isn't authorised" "$(grep -q 'DELETE repos/dashnash/stacks/actions/variables/MACOS_RUNNER stored' "$FAKE/calls" && echo 0 || echo 1)"
check "off: unsets the variable" "$([ "$(variable)" = "(unset)" ] && echo 0 || echo 1)"
check "off: deletes the variable before it looks at the runner" "$(awk '/DELETE/{d=NR} /actions\/runners/{if(!r)r=NR} END{exit !(d && (!r || d<r))}' "$FAKE/calls" && echo 0 || echo 1)"
check "off: exit 0" "$([ "$RC" = 0 ] && echo 0 || echo 1)"
teardown

setup
echo '["self-hosted","macOS","ARM64","stacks-ios"]' > "$FAKE/var"
echo true > "$FAKE/busy"
run off --now
check "off --now: doesn't wait for the running job" "$([ "$RC" = 0 ] && echo 0 || echo 1)"
check "off --now: asks GitHub about the runner only once" "$([ "$(grep -c 'actions/runners' "$FAKE/calls")" = 1 ] && echo 0 || echo 1)"
check "off --now: still unsets the variable" "$([ "$(variable)" = "(unset)" ] && echo 0 || echo 1)"
teardown

setup
echo '["self-hosted","macOS","ARM64","stacks-ios"]' > "$FAKE/var"
echo true > "$FAKE/busy"
run off --stop
check "off while busy: waits, then asks, and says no without a terminal" "$(grep -q 'Stop anyway' <<< "$OUT" && echo 0 || echo 1)"
check "off while busy: the service is left running after a no" "$(grep -q '^svc stop' "$FAKE/calls" && echo 1 || echo 0)"
check "off while busy: the variable is unset regardless" "$([ "$(variable)" = "(unset)" ] && echo 0 || echo 1)"
check "off while busy: exit 0" "$([ "$RC" = 0 ] && echo 0 || echo 1)"
teardown

setup
FAKE_SERVICE=running
run off --stop
check "off --stop when idle: stops the service" "$(grep -q '^svc stop' "$FAKE/calls" && echo 0 || echo 1)"
teardown

setup
run off
run off
check "off twice: harmless" "$([ "$RC" = 0 ] && echo 0 || echo 1)"
teardown

setup
run on
run on
check "on twice: harmless" "$([ "$RC" = 0 ] && echo 0 || echo 1)"
check "on twice: the variable is set once, to the right value" "$([ "$(variable)" = '["self-hosted","macOS","ARM64","stacks-ios"]' ] && echo 0 || echo 1)"
teardown

echo "$PASSED passed, $FAILURES failed"
[ "$FAILURES" = 0 ]
