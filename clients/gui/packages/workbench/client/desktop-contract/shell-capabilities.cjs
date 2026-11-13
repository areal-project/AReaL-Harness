// @ts-check
"use strict";
// 桌面壳能力清单：preload 暴露给界面的每个成员、主进程自己处理的每条命令，都在这里归类。
// shell：只有桌面能做、网页不需要等价物的系统能力（截图、窗口、系统对话框、自动更新、通知）。
// transitional：业务读写暂时走 IPC，网页那边已走 Host；目标是迁到 Host 后从这里删掉。
// shell-capabilities.test.cjs 把清单和 preload.cjs、transport.cjs 绑在一起，transitional 只减不增。

/** @typedef {{kind:'shell'|'transitional', reason:string}} Capability */

/** @type {Record<string, Capability>} */
const bridge = {};
/** @param {'shell'|'transitional'} kind @param {string} reason @param {string} names */
const add = (kind, reason, names) => {
  for (const name of names.trim().split(/\s+/)) bridge[name] = { kind, reason };
};

add(
  "shell",
  "系统截图与录屏权限",
  `getSnapShotState requestSnapShotPermissions setupSnapShot captureSnapShot checkSnapShotShortcut
   setSnapShotShortcutSuppressed listPendingSnapShots readSnapShot setSnapShotAnimationDestination
   dismissSnapShotAnimation acknowledgeSnapShot onSnapShotEvent`,
);
add("shell", "拖入文件的本机路径", "droppedFilePath");
add("shell", "向 Host 换取本机票据", "getHostTicket");
add("shell", "原生菜单与对话框语言", "setInterfaceLocale");
add("shell", "窗口首帧显示", "presentReady");
add("shell", "安装命令行工具到系统路径", "installCommandLineTools");
add("shell", "退出流程与进度", "onQuitProgress onQuitRequested");
add("shell", "原生窗口关闭确认与重新显示", "onWindowClosing onWindowOpened");
add("shell", "桌面自动更新", "updateState downloadUpdate recoverUpdateResources onUpdate");
add("shell", "系统深链接", "onMcpAppDeepLink");
add("shell", "内嵌预览窗口", "preview onPreviewEvent");
add("shell", "系统目录选择框", "chooseTaskDirectory chooseProjectlessDirectory");
add("shell", "用系统应用打开文件", "fileOpen");
add("shell", "用系统浏览器打开授权页等外部链接", "openExternal");
add("shell", "窗口外观主题", "theme onTheme");
add("shell", "系统通知点击", "onNotificationOpen");

add("transitional", "业务命令；网页走 Host desktop.command 与 session.*", "command");
add(
  "transitional",
  "旧版整体快照与投影；网页走 Host 读模型",
  "snapshot requestProjection onProjection",
);
add("transitional", "选目录后加项目，加项目这一步是业务", "chooseProject");
add("transitional", "MCP 页面读写；网页走 Host 页面", "mcpApp mcpFormResource onMcpAppEvent");

/**
 * 主进程直接处理、不转给后台的命令（transport.cjs 里标为 main 的那些）。
 * @type {Record<string, Capability>}
 */
const mainCommands = {
  serviceLifecycle: { kind: "shell", reason: "启停与升级桌面带起的后台、退出应用" },
  hostInstallation: { kind: "shell", reason: "安装或卸载本机 Host" },
  hostUpdate: { kind: "shell", reason: "升级本机 Host" },
  stopService: { kind: "shell", reason: "停止桌面带起的后台" },
  browserData: { kind: "shell", reason: "内置浏览器的本机数据" },
  computerControl: { kind: "shell", reason: "系统辅助功能权限与电脑控制进程" },
  bugReport: { kind: "shell", reason: "截图与本机保存" },
  exportDiagnostics: { kind: "shell", reason: "系统保存对话框" },
  serviceStatus: { kind: "transitional", reason: "后台状态；应由 Host 统一给出" },
  recoverResources: { kind: "transitional", reason: "后台恢复；应由 Host 统一处理" },
  connectService: { kind: "transitional", reason: "连接后台；界面全走 Host 后不再需要" },
  remoteControl: { kind: "transitional", reason: "远程控制配置属于业务" },
};

/**
 * 走后台命令表、但只能在桌面窗口执行的操作（renderer/src/host-workbench.ts 的 desktopKeepsCommand）。
 * 键为“命令.操作”或“命令.settings:设置项”，`*` 表示同前缀的一组操作。
 * @type {Record<string, Capability>}
 */
const desktopOperations = {
  "manage.pluginArchivePick": { kind: "shell", reason: "系统文件选择框选插件包" },
  "manage.pluginArchiveImport": { kind: "shell", reason: "导入刚在系统文件框里选中的插件包" },
  "manage.process*": { kind: "shell", reason: "本机终端进程绑定桌面窗口持有的终端会话" },
  "library.settings:computerControlEnabled": {
    kind: "shell",
    reason: "电脑控制要系统辅助功能权限，改设置前先停掉本机控制进程",
  },
  "library.settings:computerControlProvider": {
    kind: "shell",
    reason: "电脑控制要系统辅助功能权限，改设置前先停掉本机控制进程",
  },
  "library.settings:computerControlExecutable": {
    kind: "shell",
    reason: "电脑控制要系统辅助功能权限，改设置前先停掉本机控制进程",
  },
};

/** 业务仍走 IPC 的上限：迁走一项就把对应数字减一，不允许加回去。 */
const transitionalLimit = { bridge: 8, mainCommands: 4 };

module.exports = { bridge, mainCommands, desktopOperations, transitionalLimit };
