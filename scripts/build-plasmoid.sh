#!/usr/bin/env bash
# Build the self-contained KDE Store archive.

set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"

for command_name in node bsdtar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: '$command_name' is required to build the plasmoid." >&2
    exit 1
  fi
done

version="$(node -e "const m=require('./package/metadata.json'); process.stdout.write(m.KPlugin.Version)")"
staging_dir="$(mktemp -d)"
trap 'rm -rf -- "$staging_dir"' EXIT

cp -a package/. "$staging_dir/"
cp LICENSE "$staging_dir/COPYING"

mkdir -p "$staging_dir/contents/tools/lib"
install -m 0755 scripts/ai-usage-collect.mjs "$staging_dir/contents/tools/"
install -m 0755 scripts/ai-usage-clear-errors.mjs "$staging_dir/contents/tools/"
install -m 0755 scripts/ai-usage-accounts.mjs "$staging_dir/contents/tools/"
install -m 0644 scripts/lib/accounts.mjs "$staging_dir/contents/tools/lib/"
install -m 0644 scripts/lib/account-identity.mjs "$staging_dir/contents/tools/lib/"
install -m 0644 scripts/lib/antigravity.mjs "$staging_dir/contents/tools/lib/"
install -m 0644 scripts/lib/chrome-profile.mjs "$staging_dir/contents/tools/lib/"
install -m 0644 scripts/lib/provider-state.mjs "$staging_dir/contents/tools/lib/"
install -m 0644 scripts/lib/structured-sources.mjs "$staging_dir/contents/tools/lib/"
install -m 0644 scripts/lib/web-parsers.mjs "$staging_dir/contents/tools/lib/"
install -m 0644 scripts/lib/xvfb.mjs "$staging_dir/contents/tools/lib/"

mkdir -p dist
archive="dist/ai-usage-kde-${version}.plasmoid"
rm -f -- "$archive"
(
  cd "$staging_dir"
  bsdtar --format zip -cf "$repo_dir/$archive" .
)

echo "$archive"
