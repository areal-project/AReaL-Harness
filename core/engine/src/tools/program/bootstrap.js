(function (hostCall, namesJson, maxTextBytes, remainingMs) {
  "use strict";
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const parts = [];
  let textBytes = 0;
  let imageCount = 0;
  const nativeResults = new WeakSet();
  const tools = Object.create(null);
  for (const name of parse(namesJson)) {
    tools[name] = function (args) {
      const result = parse(hostCall(name, stringify(args)));
      nativeResults.add(result);
      return result;
    };
  }
  Object.freeze(tools);
  function text(value) {
    // 强制子收据已包含身份、状态及错误；选定观察只携带关联与正文，程序内对象不变。
    if (nativeResults.has(value) && value.data != null) {
      const data = value.data;
      value = { itemId: value.itemId, data };
    }
    const s = typeof value === "string" ? value : (stringify(value) ?? String(value));
    // 按真实 UTF-8 字节检查归档上限；模型展示限制由 Core 在完整保存后单独执行。
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      textBytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    }
    if (textBytes > maxTextBytes)
      throw new Error(
        "program selected text exceeds the 1 MiB archive limit; completed effects are retained",
      );
    parts.push({ type: "inputText", text: s });
  }
  function image(result) {
    if (!result || typeof result.callId !== "string")
      throw new Error("image expects an original native result");
    if (++imageCount > 4) throw new Error("at most four image results per program");
    parts.push({ type: "programImage", callId: result.callId });
  }
  async function collect(result, options = {}) {
    // 只回收同一原生进程，不启动替代命令，也不依据日志选择恢复方案。
    if (!nativeResults.has(result) || typeof result.data?.processId !== "string")
      throw new Error("collect expects an original process result");
    const { timeoutMs = 540000, maxReads = 16 } = options;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 1800000 ||
        !Number.isInteger(maxReads) || maxReads < 0 || maxReads > 64)
      throw new Error("collect requires timeoutMs 0..1800000 and maxReads 0..64");
    const processId = result.data.processId;
    const initialRemaining = remainingMs();
    const budget = Math.min(timeoutMs, Math.max(0, initialRemaining - 100));
    let reads = 0;
    let reason;
    while (true) {
      text(result);
      if (!result.success) { reason = "failed"; break; }
      if (result.data.processComplete === true && result.data.outputReadComplete === true)
        return result;
      if (reads >= maxReads) { reason = "readLimit"; break; }
      const left = Math.min(budget - (initialRemaining - remainingMs()), remainingMs() - 100);
      if (left <= 0) { reason = "waitBudget"; break; }
      const before = result.data.nextCursor;
      result = await tools.read_process({ processId, waitMs: Math.min(120000, Math.floor(left)) });
      reads++;
      if (result.data?.processId !== processId) {
        text(result);
        throw new Error("collect process identity changed or result is unavailable");
      }
      // 已结束但没有游标进展时，继续机械拉取不能获得新证据。
      if (result.success && result.data.processComplete === true &&
          result.data.outputReadComplete === false && result.data.nextCursor === before) {
        text(result); reason = "noProgress"; break;
      }
    }
    text({ collection: { reason, reads, processId, nextCursor: result.data.nextCursor,
      processComplete: result.data.processComplete, outputReadComplete: result.data.outputReadComplete } });
    return result;
  }
  return {
    execute: (code) =>
      new AsyncFunction("tools", "text", "image", "collect", '"use strict";\n' + code)(tools, text, image, collect),
    output: () => stringify(parts),
  };
});
