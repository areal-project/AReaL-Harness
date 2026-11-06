import type { ReactNode } from "react";

export interface AppSlashCommand {
  value: string;
  label: string;
  description: string;
  icon: ReactNode;
  keywords?: readonly string[];
  preserveInputUntilAccepted?: boolean;
  run: () => void | Promise<void>;
}

/** 光标前的输入符号：@ 引用文件与资源，/ 命令与功能，$ 选 Skill。“$5”这类金额不算。 */
export function composerTriggerBeforeCaret(text: string) {
  const match = /(?:^|\s)(@[^\s@]*|\/[^\s/@]*|\$[^\s$]*)$/.exec(text);
  if (!match || /^\$\d/.test(match[1])) return null;
  return {
    length: match[1].length,
    trigger: match[1][0] as "@" | "/" | "$",
    query: match[1].slice(1).toLowerCase(),
  };
}
