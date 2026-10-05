import json
import sys

args = json.load(sys.stdin)
if args.get("fail"):
    print("failed", file=sys.stderr)
    raise SystemExit(3)
print(json.dumps({"echo": args.get("value")}))
