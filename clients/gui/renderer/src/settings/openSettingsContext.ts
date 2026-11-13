import { createContext, useContext } from "react";

/** 界面内“去设置”链接；预览与单测没有工作台时为 null，调用方退回纯文字。 */
export const OpenSettingsContext = createContext<((tab: string) => void) | null>(null);
export const useOpenSettings = () => useContext(OpenSettingsContext);
