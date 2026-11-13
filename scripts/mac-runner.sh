#!/usr/bin/env bash
# Moves the iOS macOS jobs (.github/workflows/ios.yml) between this Mac and GitHub's macos-26.
#
#   stacks-runner status                  where the jobs go, and whether the runner is up
#   stacks-runner on                      admin: start the runner, then route the jobs here
#   stacks-runner off [--now] [--stop]    route them back to GitHub (anyone on this Mac)
#   stacks-runner install                 admin, once: link the command, store the token, sleep watcher
#   stacks-runner uninstall               reverse install, and off
#
# Routing is the repository variable MACOS_RUNNER: unset means GitHub's macos-26. See docs/IOS_SETUP.md.
set -euo pipefail

REPO=dashnash/stacks
LABEL=stacks-ios
VALUE='["self-hosted","macOS","ARM64","stacks-ios"]'
RUNNER_USER=ci
CI_HOME=${STACKS_CI_HOME:-$(eval echo "~$RUNNER_USER")}
RUNNER_DIR=${STACKS_RUNNER_DIR:-$CI_HOME/actions-runner}
TOKEN_FILE=${STACKS_TOKEN_FILE:-/Library/Application Support/stacks-runner/token}
XCODE_APPS=${STACKS_XCODE_DIR:-/Applications}
WATCHER_BIN=/usr/local/libexec/stacks-runner-sleepwatch
PLIST=$CI_HOME/Library/LaunchAgents/com.dashyhq.stacks-runner.sleepwatch.plist
# Waits, in seconds (the tests shorten them).
ONLINE_WAIT=${STACKS_ONLINE_WAIT:-120}
ONLINE_POLL=${STACKS_ONLINE_POLL:-5}
BUSY_WAIT=${STACKS_OFF_WAIT:-2700}
BUSY_POLL=${STACKS_BUSY_POLL:-30}

BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT
HTTP_CODE=000
RUNNER_STATUS=none
RUNNER_BUSY=false
ROUTING=""

die() { echo "stacks-runner: $*" >&2; exit 1; }

# Runs a command as the runner's user (directly, if we already are that user).
as_ci() {
  if [ "$(id -un)" = "$RUNNER_USER" ]; then "$@"; else sudo -u "$RUNNER_USER" "$@"; fi
}

# The caller's own gh login, if there is one. The sleep watcher runs as ci, which has none.
caller_token() {
  if command -v gh > /dev/null 2>&1; then gh auth token 2> /dev/null || true; fi
}

stored_token() { cat "$TOKEN_FILE" 2> /dev/null || true; }

# One GitHub API call with this token. Sets HTTP_CODE; the response body is in BODY_FILE.
send() { # token method path [json]
  local token=$1 method=$2 path=$3 json=${4:-}
  local -a args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" -H 'Accept: application/vnd.github+json' -H @-)
  if [ -n "$json" ]; then args+=(-H 'Content-Type: application/json' --data-binary "$json"); fi
  HTTP_CODE=$(printf 'Authorization: Bearer %s\n' "$token" | curl "${args[@]}" "https://api.github.com/$path") || HTTP_CODE=000
}

# The caller's login only (for `on`, which must be a repo admin).
api_caller() { send "$(caller_token)" "$@"; }

# The caller's login, else the stored token, when GitHub refuses the first (for `off` and `status`).
api_any() {
  send "$(caller_token)" "$@"
  if [ "$HTTP_CODE" = 401 ] || [ "$HTTP_CODE" = 403 ]; then
    local stored
    stored=$(stored_token)
    if [ -n "$stored" ]; then send "$stored" "$@"; fi
  fi
}

# Sets RUNNER_STATUS (online, offline or none) and RUNNER_BUSY (true or false).
runner_state() {
  api_any GET "repos/$REPO/actions/runners?per_page=100"
  [ "$HTTP_CODE" = 200 ] || die "cannot read the runners from GitHub (HTTP $HTTP_CODE)"
  local line
  line=$(jq -r --arg l "$LABEL" '[.runners[] | select(any(.labels[]; .name == $l))][0] | if . == null then "none false" else "\(.status) \(.busy)" end' "$BODY_FILE")
  RUNNER_STATUS=${line% *}
  RUNNER_BUSY=${line#* }
}

# Sets ROUTING to MACOS_RUNNER's value, or "" when it is unset.
routing_value() {
  api_any GET "repos/$REPO/actions/variables/MACOS_RUNNER"
  case "$HTTP_CODE" in
    200) ROUTING=$(jq -r .value "$BODY_FILE") ;;
    404) ROUTING="" ;;
    *) die "cannot read MACOS_RUNNER (HTTP $HTTP_CODE)" ;;
  esac
}

delete_variable() {
  api_any DELETE "repos/$REPO/actions/variables/MACOS_RUNNER"
  case "$HTTP_CODE" in
    204 | 404) ;; # 404: already unset, which is the state we want
    *) die "cannot unset MACOS_RUNNER (HTTP $HTTP_CODE). Check $TOKEN_FILE, or run as a repo admin." ;;
  esac
}

set_variable() {
  send "$(caller_token)" PATCH "repos/$REPO/actions/variables/MACOS_RUNNER" "$(jq -n --arg v "$VALUE" '{value: $v}')"
  if [ "$HTTP_CODE" = 404 ]; then
    send "$(caller_token)" POST "repos/$REPO/actions/variables" "$(jq -n --arg v "$VALUE" '{name: "MACOS_RUNNER", value: $v}')"
  fi
  case "$HTTP_CODE" in
    201 | 204) ;;
    *) die "cannot set MACOS_RUNNER (HTTP $HTTP_CODE)" ;;
  esac
}

require_admin() {
  [ -n "$(caller_token)" ] || die "log in with gh as a repo admin first: gh auth login"
  api_caller GET "repos/$REPO"
  [ "$HTTP_CODE" = 200 ] || die "cannot read $REPO with your gh login (HTTP $HTTP_CODE)"
  [ "$(jq -r .permissions.admin "$BODY_FILE")" = true ] || die "only a repo admin can switch the runner on"
}

# Prints the developer directory of the newest installed Xcode, by version number (the job picks the same one as ci).
find_xcode() {
  local candidate version ver best="" bestver=""
  for candidate in "$XCODE_APPS"/Xcode*.app; do
    [ -d "$candidate" ] || continue
    version=$(DEVELOPER_DIR="$candidate/Contents/Developer" xcodebuild -version 2> /dev/null | head -n 1 || true)
    case "$version" in
      "Xcode "[0-9]*) ;;
      *) continue ;;
    esac
    ver=${version#Xcode }
    if [ -z "$bestver" ] || [ "$(printf '%s\n%s\n' "$bestver" "$ver" | sort -V | tail -n 1)" = "$ver" ]; then
      best=$candidate
      bestver=$ver
    fi
  done
  [ -n "$best" ] || return 1
  echo "$best/Contents/Developer"
}

service_running() { pgrep -u "$RUNNER_USER" -f 'Runner.Listener' > /dev/null 2>&1; }

service() { # start | stop
  [ -x "$RUNNER_DIR/svc.sh" ] || die "no runner in $RUNNER_DIR (docs/IOS_SETUP.md, the runner steps)"
  (cd "$RUNNER_DIR" && as_ci ./svc.sh "$1") || die "svc.sh $1 failed"
}

wait_online() {
  local waited=0
  until
    runner_state
    [ "$RUNNER_STATUS" = online ]
  do
    [ "$waited" -lt "$ONLINE_WAIT" ] || return 1
    sleep "$ONLINE_POLL"
    waited=$((waited + ONLINE_POLL))
  done
}

confirm() { # prompt; only a person at a terminal can say yes
  if [ -t 0 ]; then
    local answer
    read -r -p "$1" answer
    [[ "$answer" =~ ^[Yy] ]]
  else
    echo "$1no (not interactive)"
    return 1
  fi
}

cmd_status() {
  if service_running; then echo "Runner service: running (as $RUNNER_USER)"; else echo "Runner service: stopped"; fi
  runner_state
  case "$RUNNER_STATUS" in
    online) if [ "$RUNNER_BUSY" = true ]; then echo "GitHub: runner online, busy"; else echo "GitHub: runner online, idle"; fi ;;
    offline) echo "GitHub: runner offline" ;;
    *) echo "GitHub: no runner with the label $LABEL" ;;
  esac
  routing_value
  if [ -n "$ROUTING" ]; then echo "MACOS_RUNNER: $ROUTING"; else echo "MACOS_RUNNER: unset (iOS jobs go to macos-26)"; fi
  if [[ "$ROUTING" == *"$LABEL"* ]] && [ "$RUNNER_STATUS" != online ]; then
    echo "WARNING: MACOS_RUNNER points here, but the runner is not online. iOS jobs will queue. Run: stacks-runner off"
    return 2
  fi
}

cmd_on() {
  require_admin
  local xcode
  xcode=$(find_xcode) || die "no Xcode found in $XCODE_APPS"
  echo "Xcode: $xcode"
  if service_running; then
    echo "Runner service: already running"
  else
    echo "Starting the runner service as $RUNNER_USER (this may ask for an admin password)"
    service start
  fi
  echo "Waiting for GitHub to see the runner online..."
  wait_online || die "the runner is not online after ${ONLINE_WAIT}s; MACOS_RUNNER is unchanged (stacks-runner status)"
  set_variable
  echo "MACOS_RUNNER set: iOS macOS jobs now run on this Mac."
}

cmd_off() {
  local now=0 stop=0 arg
  for arg in "$@"; do
    case "$arg" in
      --now) now=1 ;;
      --stop) stop=1 ;;
      *) die "unknown option: $arg" ;;
    esac
  done
  # First, so new jobs go to GitHub at once, even while a job here is still running.
  delete_variable
  echo "MACOS_RUNNER unset: iOS macOS jobs go to GitHub's macos-26."
  runner_state
  if [ "$RUNNER_BUSY" = true ] && [ "$now" = 0 ]; then
    echo "A job is running here. Waiting up to $((BUSY_WAIT / 60)) minutes for it to finish..."
    local waited=0
    while [ "$RUNNER_BUSY" = true ] && [ "$waited" -lt "$BUSY_WAIT" ]; do
      sleep "$BUSY_POLL"
      waited=$((waited + BUSY_POLL))
      runner_state
    done
  fi
  if [ "$RUNNER_BUSY" = true ]; then
    if [ "$stop" = 0 ]; then
      echo "A job is still running here. The runner stays on and gets no new jobs."
      return 0
    fi
    if ! confirm "A job is still running. Stop anyway? [y/N] "; then
      echo "Left running. It gets no new jobs."
      return 0
    fi
  fi
  if [ "$stop" = 1 ]; then
    if service_running; then service stop; echo "Runner service stopped."; else echo "Runner service already stopped."; fi
  fi
}

cmd_install() {
  local self repo_root tmp token plist_tmp ci_uid
  self=$(realpath "$0")
  repo_root=$(cd "$(dirname "$self")/.." && pwd)
  [ -f "$repo_root/native/runner/SleepWatcher.swift" ] || die "SleepWatcher.swift not found in $repo_root"

  sudo mkdir -p /usr/local/bin /usr/local/libexec "$(dirname "$TOKEN_FILE")"
  sudo ln -sf "$self" /usr/local/bin/stacks-runner
  echo "Linked /usr/local/bin/stacks-runner"

  printf 'Fine-grained token for %s (Variables read/write, Administration read): ' "$REPO"
  read -rs token
  echo
  [ -n "$token" ] || die "no token given"
  tmp=$(mktemp)
  printf '%s\n' "$token" > "$tmp"
  sudo install -m 0640 -o root -g staff "$tmp" "$TOKEN_FILE"
  rm -f "$tmp"
  echo "Stored the token in $TOKEN_FILE"

  tmp=$(mktemp -d)
  swiftc -O "$repo_root/native/runner/SleepWatcher.swift" -o "$tmp/sleepwatch"
  sudo install -m 0755 "$tmp/sleepwatch" "$WATCHER_BIN"
  rm -rf "$tmp"
  echo "Built the sleep watcher into $WATCHER_BIN"

  plist_tmp=$(mktemp)
  cat > "$plist_tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dashyhq.stacks-runner.sleepwatch</string>
  <key>ProgramArguments</key><array><string>$WATCHER_BIN</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
  as_ci mkdir -p "$(dirname "$PLIST")"
  as_ci tee "$PLIST" < "$plist_tmp" > /dev/null
  rm -f "$plist_tmp"
  ci_uid=$(id -u "$RUNNER_USER")
  as_ci launchctl bootout "gui/$ci_uid" "$PLIST" 2> /dev/null || true
  if as_ci launchctl bootstrap "gui/$ci_uid" "$PLIST"; then
    echo "Sleep watcher started for $RUNNER_USER"
  else
    echo "Sleep watcher installed. It starts once $RUNNER_USER is logged in (fast user switching)."
  fi
  echo "Done. Try: stacks-runner status"
}

cmd_uninstall() {
  cmd_off --now
  local ci_uid
  ci_uid=$(id -u "$RUNNER_USER")
  as_ci launchctl bootout "gui/$ci_uid" "$PLIST" 2> /dev/null || true
  as_ci rm -f "$PLIST"
  sudo rm -f "$WATCHER_BIN" "$TOKEN_FILE" /usr/local/bin/stacks-runner
  echo "Removed the command, the token and the sleep watcher."
  echo "The runner service, if it is running, is still up: stacks-runner off --stop"
}

main() {
  local cmd=${1:-status}
  [ "$#" -eq 0 ] || shift
  case "$cmd" in
    status) cmd_status "$@" ;;
    on) cmd_on "$@" ;;
    off) cmd_off "$@" ;;
    install) cmd_install "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    *) die "usage: stacks-runner status | on | off [--now] [--stop] | install | uninstall" ;;
  esac
}

main "$@"
