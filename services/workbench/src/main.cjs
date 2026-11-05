"use strict";
// Host 监督的工作台服务入口。领域按 A3 逐个搬入 domains。
const { serve } = require("./channel.cjs");

const domains = {};

serve({ input: process.stdin, output: process.stdout, domains }).then(() => process.exit(0));
