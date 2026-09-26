"""把 Core 的终止原因投影到 EnvArena；不解释人类可读错误文案。"""

SCHEMA = "areal.envarena-outcome.v1"


def runner_outcome(code, source, reason, kind="infrastructure"):
    return {
        "schema": SCHEMA,
        "code": code,
        "class": kind,
        "source": source,
        "details": {"reason": reason},
    }


def core_outcome(threads):
    # 根线程先于子线程，避免文件枚举顺序改变主任务归因。
    ordered = sorted(threads, key=lambda t: bool(t.get("parentThreadId")))
    for thread in ordered:
        for turn in reversed(thread.get("turns", [])):
            if turn.get("status") != "failed":
                continue
            error = turn.get("error") or {}
            outcome = error.get("outcome") if isinstance(error, dict) else None
            if isinstance(outcome, dict) and all(
                isinstance(outcome.get(k), str) and outcome[k] for k in ("code", "class", "source")
            ):
                return {**outcome, "schema": SCHEMA}
            # 老 Core 的失败信息没有类型，不能借子线程或文案补猜主任务原因。
            return runner_outcome("HARNESS_INTERNAL_ERROR", "core_legacy", "missing_outcome")
    return None


def finalize(result, threads=(), *, timed_out=False, interrupted=False, adapter_error=False):
    if result["status"] == "OK":
        outcome = runner_outcome("AGENT_COMPLETED", "runner", "completed", "success")
    elif adapter_error:
        outcome = runner_outcome("HARNESS_INTERNAL_ERROR", "runner", "adapter_error")
    elif timed_out:
        outcome = runner_outcome(
            "AGENT_RUN_TIMEOUT", "runner_deadline", "process_deadline", "agent"
        )
    elif interrupted:
        outcome = runner_outcome("HARNESS_INTERRUPTED", "runner_signal", "external_signal")
    else:
        outcome = core_outcome(threads) or runner_outcome(
            "HARNESS_INTERNAL_ERROR", "runner", "missing_terminal_outcome"
        )
    raw = {**result.get("raw", {}), "outcome": outcome}
    if adapter_error:
        # 收集/适配失败仍作为主因；同时保存模型原因，不能因后续错误抹掉证据。
        raw["adapter_error"] = {"message": result.get("error")}
        original = core_outcome(threads)
        if original is not None:
            raw["core_outcome"] = original
            raw["core_errors"] = [
                {
                    "thread_id": thread.get("id"),
                    "turn_id": turn.get("id"),
                    "status": turn.get("status"),
                    "error": turn.get("error"),
                }
                for thread in threads
                for turn in thread.get("turns", [])
                if turn.get("status") == "failed"
            ]
        if timed_out:
            raw["runner_outcome"] = runner_outcome(
                "AGENT_RUN_TIMEOUT", "runner_deadline", "process_deadline", "agent"
            )
        elif interrupted:
            raw["runner_outcome"] = runner_outcome(
                "HARNESS_INTERRUPTED", "runner_signal", "external_signal"
            )
    result["raw"] = raw
    # 兼容 AReaL 现有的日志 fallback；结构化 raw.outcome 是首选契约。
    marker = f"GAMEAGENT_OUTCOME_CODE={outcome['code']} GAMEAGENT_OUTCOME_CLASS={outcome['class']}"
    result["summary"] = marker
    return marker
