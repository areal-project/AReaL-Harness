// Core 的各入口是独立 schema；保留其局部引用作用域，Host 只引用入口。
function addHostProtocolSchemas(ajv, host, core) {
  const registry = structuredClone(core);
  registry.$id = "urn:areal:core-protocol:v1";
  for (const section of [
    "requests",
    "responses",
    "serverRequests",
    "serverResponses",
    "notifications",
  ]) {
    for (const [method, schema] of Object.entries(registry[section])) {
      if (typeof schema !== "object" || schema === null) continue;
      schema.$id = `${registry.$id}?resource=${encodeURIComponent(`${section}/${method}`)}`;
      ajv.addSchema(schema);
    }
  }
  ajv.addSchema(registry);
  ajv.addSchema(host);
}

module.exports = { addHostProtocolSchemas };
