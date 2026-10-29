#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
baseline_dir=/tmp/fully-flared-gate0-baseline
python3 - "$repo_dir/.audit/gate0/evidence/baseline-source.tar.gz" <<'CHECK_ARCHIVE'
import hashlib,sys
assert hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest() == 'b723f9027e8ae911be164ddbb26f0d12f8d1ab346baef3f09f98e53cadc96878', 'Source archive hash mismatch'
CHECK_ARCHIVE
if [ ! -f "$baseline_dir/web/migrations/0000_initial.sql" ]; then
  mkdir -p "$baseline_dir"
  tar -xzf "$repo_dir/.audit/gate0/evidence/baseline-source.tar.gz" -C "$baseline_dir"
fi
if [ ! -e "$baseline_dir/node_modules" ]; then ln -s "$repo_dir/node_modules" "$baseline_dir/node_modules"; fi
if [ ! -e "$baseline_dir/web/node_modules" ]; then ln -s "$repo_dir/web/node_modules" "$baseline_dir/web/node_modules"; fi
python3 - "$repo_dir/.audit/gate0/evidence/baseline-source.tar.gz" "$baseline_dir" <<'CHECK_SOURCE'
import hashlib,sys,tarfile
from pathlib import Path
base=Path(sys.argv[2])
bad=[]
with tarfile.open(sys.argv[1],'r:gz') as archive:
    for member in archive.getmembers():
        if not member.isfile(): continue
        path=base/member.name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).digest()!=hashlib.sha256(archive.extractfile(member).read()).digest(): bad.append(member.name)
if bad: raise SystemExit('Existing baseline differs from archived main; do not run probes until restored: '+', '.join(bad))
print('Verified every archived source file against the exact-main archive.')
CHECK_SOURCE
printf '%s\n' 'Baseline ready. Source archive is pinned; installed dependencies are reused, not independently restored.'
