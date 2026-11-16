// @ts-check
"use strict";
const providerContract = require("./provider-contract.cjs");
/** @param {unknown} value */
function errorMessage(value) {
  return value instanceof Error
    ? value.message
    : providerContract.record(value) && typeof value.message === "string"
      ? value.message
      : String(value);
}

module.exports = { errorMessage };
