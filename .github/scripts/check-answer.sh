#!/usr/bin/env bash
# The post-deploy check (PRD Q11): asks the deployed app one question the way
# a browser does, and fails unless the reply is an answer with a citation.
# It loads the parent view for a sandbox cookie, then asks with that cookie.
#
#   bash .github/scripts/check-answer.sh <base URL>
#
# The ask is never retried: each try spends a call from the daily model-call
# limit. The page load makes no model call, so it may retry. The whole run
# gives up within 120 seconds.

set -euo pipefail

base="${1:?usage: check-answer.sh <base URL>}"
# Text the Hours section holds word for word, so it is answerable on any day.
question='The center is open Monday to Friday.'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if ! curl --fail --silent --show-error --max-time 15 --retry 3 -c "$work/jar" -o /dev/null "$base/"; then
  echo "check failed: $base/ did not load"
  exit 1
fi

body="$(jq -n --arg message "$question" '{message: $message, priorTurns: []}')"
if ! curl --fail --silent --show-error --max-time 45 -b "$work/jar" -H 'content-type: application/json' -d "$body" -o "$work/reply.json" "$base/api/ask"; then
  echo "check failed: POST $base/api/ask did not succeed"
  exit 1
fi

if ! jq -e '.reply | type == "object"' "$work/reply.json" > /dev/null 2>&1; then
  echo "check failed: POST $base/api/ask did not answer with a reply"
  exit 1
fi
jq -r '.reply | "outcome: \(.outcome), reason: \(.reason), citations: \(.citations | length? // 0)"' "$work/reply.json"
if ! jq -e '.reply.outcome == "answer" and (.reply.citations | length) >= 1' "$work/reply.json" > /dev/null 2>&1; then
  echo "check failed: the reply is not an answer with a citation"
  exit 1
fi
echo "check passed"
