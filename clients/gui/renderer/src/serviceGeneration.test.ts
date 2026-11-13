import { expect, it } from "vite-plus/test";
import {
  executionGeneration,
  serviceGeneration,
  type ServiceGeneration,
} from "./serviceGeneration.js";

it("reads only a valid service generation, never a service instance ID", () => {
  expect(serviceGeneration({ instanceId: "service-id" })).toBeUndefined();
  expect(serviceGeneration({ serviceGeneration: "" })).toBeUndefined();
  expect(serviceGeneration({ serviceGeneration: 1 })).toBeUndefined();
  expect(serviceGeneration({ instanceId: "service-id", serviceGeneration: "generation" })).toBe(
    "generation",
  );
  expect(
    executionGeneration(
      {
        core: { serviceGeneration: "project" },
        state: {
          threads: {
            child: { executionCore: { instanceId: "service-id", serviceGeneration: "worktree" } },
          },
        },
      },
      "child",
    ),
  ).toBe("worktree");
});

// 类型检查覆盖：其他字符串身份不能传给需要服务代际的调用方。
function requiresGeneration(_generation: ServiceGeneration) {}
// @ts-expect-error service ID 不是服务代际。
requiresGeneration("service-id");
