type DraftConfiguration = {
  model?: { providerId: string; modelId: string } | null;
  parameters?: Record<string, unknown>;
};
// 未操作选择器的草稿省略模型和参数，由 Core 按历史锚点继承。
export function sideStartConfiguration(draft: DraftConfiguration | null) {
  return {
    ...(draft?.model === null ? { resetModel: true } : draft?.model ? { model: draft.model } : {}),
    ...(draft?.parameters ? { parameters: draft.parameters } : {}),
  };
}
