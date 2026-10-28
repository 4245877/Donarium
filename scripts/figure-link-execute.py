#!/usr/bin/env python3
"""Execute a reviewed plan using the deployed figure-file helper in one transaction."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

BASE = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['rehearse', 'apply', 'rollback'])
parser.add_argument('plan', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--sample-ids', type=Path)
parser.add_argument('--operation-id')
parser.add_argument('--verify-rollback-only', action='store_true')
args = parser.parse_args()
os.umask(0o077)
plan_text = args.plan.read_text()
plan = json.loads(plan_text)
arguments = dict(action=args.action, planSha256=hashlib.sha256(plan_text.encode()).hexdigest(),
                 operationId=args.operation_id, verifyRollbackOnly=args.verify_rollback_only)
if args.sample_ids:
    arguments['sampleIds'] = json.loads(args.sample_ids.read_text())
source = 'const plan = ' + json.dumps(plan, ensure_ascii=True) + ';\n' + (BASE / 'scripts/figure-link-apply.mjs').read_text()
result = subprocess.run(['docker', 'exec', '-i', '-e', 'FIGURE_LINK_ARGUMENTS='+json.dumps(arguments),
                         'donarium-app-1', 'node', '--input-type=module'], input=source.encode(), capture_output=True)
with open(args.output, 'xb') as stream:
    stream.write(result.stdout or result.stderr)
print((result.stdout or result.stderr).decode(), end='')
if result.returncode:
    if result.stdout and result.stderr:
        print(result.stderr.decode())
    raise SystemExit(result.returncode)
