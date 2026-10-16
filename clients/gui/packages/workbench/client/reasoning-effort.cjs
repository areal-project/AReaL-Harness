"use strict";

const reasoningEffortLabels = Object.freeze({
    none: "无",
    minimal: "最少",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "Max",
    ultra: "Ultra",
});
module.exports = { reasoningEffortLabels, reasoningEfforts: Object.keys(reasoningEffortLabels) };
