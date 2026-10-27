#!/data/data/com.termux/files/usr/bin/bash
set -eu
cd "$HOME/qqrobot-termux-e"
exec > >(tee "$PWD/run.log") 2>&1
trap 'result=$?; printf "%s\n" "$result" > "$PWD/run.exit"' EXIT
id -u
npm ci --offline --ignore-scripts --no-audit --no-fund --cache "$HOME/.npm" --registry=https://registry.npmjs.org
timeout --signal=TERM --kill-after=5 30 node ./network-policy-acceptance.cjs
timeout --signal=TERM --kill-after=5 90 node --require ./network-guard.cjs ./acceptance.mjs
timeout --signal=TERM --kill-after=5 45 node ./service-acceptance.mjs
echo E_TERMUX_TESTS_COMPLETE
