import { expect, test } from "vite-plus/test";
import { catalogs, type MessageId } from "../i18n/messages.js";
import { UiMessageError, type Translate } from "../i18n/uiMessage.js";
import { ERROR_CODES, presentError } from "./errorCopy.js";

const zh: Translate = (id) => catalogs["zh-CN"][id];

test("every registered code has user copy in both languages", () => {
  for (const [code, entry] of Object.entries(ERROR_CODES)) {
    const id = ("message" in entry ? entry.message : `errors.${code}`) as MessageId;
    expect(catalogs["zh-CN"][id], code).toBeTruthy();
    expect(catalogs.en[id], code).toBeTruthy();
  }
});

test("registered codes show their copy and keep the backend text out of the sentence", () => {
  const error = Object.assign(new Error("命令未受理，请刷新状态后检查草稿"), {
    code: "TARGET_CHANGED",
  });
  const shown = presentError(zh, error);
  expect(shown.message).toBe(catalogs["zh-CN"]["errors.TARGET_CHANGED"]);
  expect(shown.message).not.toContain("受理");
  expect(shown.detail).toBe("TARGET_CHANGED: 命令未受理，请刷新状态后检查草稿");
  expect(shown.action).toBe("refresh");
  const lost = presentError(
    zh,
    Object.assign(new Error("Host disconnected"), { clientCode: "DISCONNECTED" }),
  );
  expect(lost.message).toBe(catalogs["zh-CN"]["errors.DISCONNECTED"]);
  expect(lost.action).toBe("reconnect");
});

test("unknown errors fall back to a generic sentence with the raw text only in details", () => {
  const shown = presentError(zh, new Error("Project Core unavailable: control.sock"));
  expect(shown.message).toBe(catalogs["zh-CN"]["errors.generic"]);
  expect(shown.detail).toBe("Project Core unavailable: control.sock");
  expect(presentError(zh, { code: -32003, message: "denied" }).message).toBe(
    catalogs["zh-CN"]["errors.generic"],
  );
});

test("an unsupported fork profile explains the rejection without exposing backend text", () => {
  const shown = presentError(zh, {
    code: "PROFILE_NOT_SUPPORTED",
    message: "private backend data",
  });
  expect(shown.message).toBe(
    "所选执行配置不支持此操作，请选择兼容的配置。（PROFILE_NOT_SUPPORTED）",
  );
  expect(shown.message).not.toContain("private backend data");
  expect(shown.retryable).toBe(false);
});

test("submission-unknown flags and UI-authored messages keep their meaning", () => {
  expect(presentError(zh, { submissionUnknown: true, message: "x" }).message).toBe(
    catalogs["zh-CN"]["errors.SUBMISSION_UNKNOWN"],
  );
  const own = presentError(zh, new UiMessageError({ id: "errors.workerRunMissing" }));
  expect(own).toEqual({
    message: catalogs["zh-CN"]["errors.workerRunMissing"],
    action: "none",
    retryable: false,
  });
});
