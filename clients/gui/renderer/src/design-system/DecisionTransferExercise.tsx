import { useState } from "react";
import { ApprovalRequest } from "../ApprovalRequest.js";
import { CollapsibleText } from "../CollapsibleText.js";
import type { Action, CommandName } from "../services.js";

const request = {
  requestId: "transfer-approval",
  threadId: "transfer",
  tool: "shell",
  effectiveArguments: {
    command:
      "python3 scripts/check_migration.py --source '/preview/迁移资料/Project migration notes with a deliberately long descriptive directory name/configuration.json' --mode review --note '先核对参数，保留原始内容 / verify parameters before continuing'",
    cwd: "/preview",
    purpose: "仅检查模拟迁移输入，不执行任何真实命令",
  },
  effectivePermissions: { rememberAllowed: false },
};

/** New content on existing Base components; fixture actions never reach a service. */
export function DecisionTransferExercise({
  state,
}: {
  state: "ready" | "busy" | "failed" | "unknown";
}) {
  const [responses, setResponses] = useState(0);
  const [reads, setReads] = useState(0);
  const action = (async (name: CommandName) => {
    if (name === "manage") {
      setReads((value) => value + 1);
      throw new Error("模拟 Core 读取不可用。");
    }
    if (name !== "respond") throw new Error("此题只接受本地响应与核对。");
    setResponses((value) => value + 1);
    if (state === "busy") return new Promise<never>(() => {});
    if (state === "failed") throw new Error("模拟请求明确未受理，可核对参数后重试。");
    if (state === "unknown")
      throw Object.assign(new Error("模拟结果未知"), { submissionUnknown: true });
    return {};
  }) as Action;
  return (
    <section className="design-preview-panel" aria-label="内容决策迁移题">
      <h2>迁移前检查</h2>
      <p>阅读说明后核对请求。此页仅演示现有组件，不执行真实命令。</p>
      <section aria-label="迁移说明">
        <CollapsibleText>
          {Array.from({ length: 12 }, (_, index) => (
            <p key={index}>
              检查项 {index + 1}：保留迁移资料和原始参数，先确认来源与影响范围，再决定是否继续。
              Verify the source and affected scope before continuing; keep the original parameters
              available.
            </p>
          ))}
          <a href="#transfer-end">核对末段 END_OF_TRANSFER_NOTES</a>
        </CollapsibleText>
      </section>
      <ApprovalRequest item={request} projectId="design-transfer" action={action} />
      <p id="transfer-end" aria-label="本地调用记录">
        模拟响应：{responses}；模拟核对：{reads}。仅记录本页fixture调用。
      </p>
    </section>
  );
}
