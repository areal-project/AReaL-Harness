"""验证路径判定与下游结果，不把取消、失败或意外跳过当作成功。"""

import os
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

spec = spec_from_file_location("ci_scope", Path(__file__).with_name("ci-scope.py"))
module = module_from_spec(spec)
spec.loader.exec_module(module)
needed = os.environ.get("NEEDED")
results = {key: value for key, value in os.environ.items() if key.endswith("_RESULT")}
print({"needed": needed, "results": results})
valid = results and all(
    value == "success" for key, value in results.items() if key != "WORK_RESULT"
)
if "WORK_RESULT" in results:
    valid = (
        valid
        and needed in ("true", "false")
        and module.require_result(needed == "true", results["WORK_RESULT"])
    )
sys.exit(0 if valid else 1)
