(function (hostCall, namesJson, maxTextBytes) {
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
    // 原生 JSON 结果的 text 与 data 内容重复；保留程序内的两种访问方式，默认只展示一份。
    if (nativeResults.has(value) && value.data != null) {
      const { text: duplicate, ...view } = value;
      value = view;
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
  return {
    execute: (code) =>
      new AsyncFunction("tools", "text", "image", '"use strict";\n' + code)(tools, text, image),
    output: () => stringify(parts),
  };
});
