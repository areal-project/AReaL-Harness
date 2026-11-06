// 高频操作体检的 5 项确定性检查。纯函数供单测，页面函数供 ux-journeys.mjs 在每一步之后调用。

const RAW_ERRORS = [
  /Host command failed/i,
  /requires the desktop/i,
  // 协议错误码只该出现在日志里，界面要说人话。
  /\b[A-Z]{3,}(?:_[A-Z]+)+\b/,
  /\bFORBIDDEN\b/,
];

// 中文界面里不该出现的英文界面词；产品名、模型名不在此列。
const ENGLISH_CHROME = [
  "Working for",
  "Worked for",
  "Changes",
  "Subagents",
  "Sources",
  "Show more",
  "Worktrees",
];

// 有待审批时不能出现的“在跑”说法。
const RUNNING_WORDS = ["正在运行", "执行中", "运行中"];

/** 2. 没有原始错误：返回命中的原文片段。 */
export function rawErrors(text) {
  return RAW_ERRORS.flatMap((pattern) => text.match(pattern)?.[0] ?? []);
}

/** 3. 不混语言：中文界面返回出现的英文界面词。 */
export function mixedLanguage(text) {
  return ENGLISH_CHROME.filter((word) => new RegExp(`\\b${word}\\b`).test(text));
}

/** 4. 不遮挡：返回互相重叠的浮层对（容差 1px，嵌套的不算）。 */
export function overlaps(boxes) {
  const found = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j];
      if (a.contains?.includes(b.name) || b.contains?.includes(a.name)) continue;
      const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (x > 1 && y > 1) found.push([a.name, b.name]);
    }
  return found;
}

/** 5. 状态说真话：等审批时出现的“在跑”说法。 */
export function untruthfulStatus(text, awaitingApproval) {
  return awaitingApproval ? RUNNING_WORDS.filter((word) => text.includes(word)) : [];
}

// 排队条按设计压在输入框上沿之下，输入框不算浮层。
const LAYERS = {
  queue: ".composer-queue",
  approval: ".decision-card",
  menu: '[role="menu"]',
  popover: ".task-resources-popup",
};

/** 在当前页面跑检查 2–5，返回 { step, problems }。 */
export async function inspectPage(page, step, { locale = "zh-CN" } = {}) {
  const state = await page.evaluate((layers) => {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const boxes = Object.entries(layers).flatMap(([name, selector]) =>
      [...document.querySelectorAll(selector)].filter(visible).map((element, index) => {
        const box = element.getBoundingClientRect();
        const contains = Object.entries(layers)
          .filter(([other, s]) => other !== name && element.querySelector(s))
          .map(([other]) => other);
        return {
          name: `${name}#${index}`,
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          contains: contains.flatMap((other) =>
            [...document.querySelectorAll(layers[other])].map((_, i) => `${other}#${i}`),
          ),
        };
      }),
    );
    // 对话正文是模型写的，只检查界面本身。
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(".messages, [contenteditable]").forEach((node) => node.remove());
    return {
      chrome: clone.innerText,
      text: document.body.innerText,
      awaiting: !!document.querySelector('.decision-card[data-interaction="approval"]'),
      boxes,
    };
  }, LAYERS);
  const problems = [
    ...rawErrors(state.text).map((hit) => `原始错误：${hit}`),
    ...(locale === "zh-CN" ? mixedLanguage(state.chrome) : []).map((hit) => `混用英文：${hit}`),
    ...overlaps(state.boxes).map(([a, b]) => `浮层重叠：${a} 与 ${b}`),
    ...untruthfulStatus(state.chrome, state.awaiting).map((hit) => `等审批时显示“${hit}”`),
  ];
  return { step, problems };
}

/** 1. 有反馈：执行 act 后 400ms 内页面必须有可见变化，否则记为“卡住”。 */
export async function expectFeedback(page, step, act, timeout = 400) {
  await page.evaluate(() => {
    window.__uxChanged = false;
    window.__uxObserver?.disconnect();
    window.__uxObserver = new MutationObserver(() => (window.__uxChanged = true));
    window.__uxObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await act();
  const changed = await page
    .waitForFunction(() => window.__uxChanged, null, { timeout })
    .then(() => true)
    .catch(() => false);
  await page.evaluate(() => window.__uxObserver?.disconnect());
  return { step, problems: changed ? [] : [`卡住：${timeout}ms 内界面没有变化`] };
}
