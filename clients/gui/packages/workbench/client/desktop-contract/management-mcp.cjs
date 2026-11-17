// @ts-check
"use strict";
const { ContentBlockSchema } = require("@modelcontextprotocol/core");
/** @typedef {ReturnType<typeof ContentBlockSchema.parse>} McpContentBlock */

/** @param {unknown} value @returns {value is McpContentBlock} */
function isMcpContentBlock(value) {
  return ContentBlockSchema.safeParse(value).success;
}
module.exports = { isMcpContentBlock };
