import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { TaskContext } from "./task-context.js";

describe("TaskContext contract (R-TASKCONTEXT-007, R-TASKCONTEXT-009, R-TASKCONTEXT-010, R-TASKCONTEXT-012, R-TASKCONTEXT-021)", () => {
  it("renders ordered sections, caps source previews to 3 with view-all entry, and omits add button when onAdd is absent", () => {
    const sources = [
      { id: "s1", name: "spec.md" },
      { id: "s2", name: "preview.png" },
      { id: "s3", name: "api.ts" },
      { id: "s4", name: "notes.txt" },
    ];
    const withoutAdd = renderToStaticMarkup(
      <TaskContext title="任务上下文">
        <TaskContext.Section label="变更" title="AReaL-Harness">
          <TaskContext.Item title="Changes" description="2 个文件" />
        </TaskContext.Section>
        <TaskContext.Section label="子代理">
          <TaskContext.Item title="验证子任务" meta="运行中" />
        </TaskContext.Section>
        <TaskContext.Sources items={sources} onViewAll={() => {}}>
          {(item) => <TaskContext.Item title={item.name} />}
        </TaskContext.Sources>
      </TaskContext>,
    );

    expect(withoutAdd.indexOf("Changes")).toBeLessThan(withoutAdd.indexOf("验证子任务"));
    expect(withoutAdd).toContain("spec.md");
    expect(withoutAdd).toContain("api.ts");
    expect(withoutAdd).not.toContain("notes.txt");
    expect(withoutAdd).toContain('aria-label="查看全部来源（4）"');
    expect(withoutAdd).not.toContain('aria-label="添加来源"');

    const withAdd = renderToStaticMarkup(
      <TaskContext title="任务上下文">
        <TaskContext.Sources items={[]} onViewAll={() => {}} onAdd={() => {}}>
          {() => null}
        </TaskContext.Sources>
      </TaskContext>,
    );
    expect(withAdd).toContain('aria-label="添加来源"');
    expect(withAdd).toContain("还没有输入来源");
  });
});
