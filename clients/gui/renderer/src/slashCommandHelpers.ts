import type { ReactNode } from "react";

export interface AppSlashCommand {
  value: string;
  label: string;
  description: string;
  icon: ReactNode;
  keywords?: readonly string[];
  run: () => void;
}

export function parseGoalCommand(
  text: string,
): { objective: string; workflow?: "rsiArtifact"; outputFormat?: "html" } | null {
  const command = /^\/(rsi-goal|goal)(?:\s+|$)/.exec(text.trimStart());
  if (!command) return null;
  let objective = text.trimStart().slice(command[0].length).trim();
  const html = command[1] === "rsi-goal" && /^--html(?:\s+|$)/.test(objective);
  if (html) objective = objective.replace(/^--html(?:\s+|$)/, "").trim();
  return {
    objective,
    ...(html ? { outputFormat: "html" as const } : {}),
    ...(command[1] === "rsi-goal" ? { workflow: "rsiArtifact" as const } : {}),
  };
}
