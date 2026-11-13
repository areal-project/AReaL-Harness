#!/bin/bash
# 停机升级前由用户本机执行：退出旧版、停止 Host、完整备份数据目录。
# 只读原数据并复制到备份目录，不删除、不改写任何原文件。
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "本脚本只支持 macOS。" >&2
  exit 1
fi

GUI_DATA="$HOME/Library/Application Support/AReaL Harness GUI"
AREAL_HOME="${AREAL_HOME:-$HOME/.areal}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${1:-$HOME/AReaL-升级备份-$STAMP}"

echo "1/4 退出旧版桌面应用"
for app in "AReaL Harness GUI" "AReaL Harness"; do
  osascript -e "if application \"$app\" is running then tell application \"$app\" to quit" >/dev/null 2>&1 || true
done
for _ in $(seq 1 30); do
  pgrep -f "AReaL Harness" >/dev/null 2>&1 || break
  sleep 1
done
if pgrep -f "AReaL Harness" >/dev/null 2>&1; then
  echo "桌面应用仍在运行。请手动退出（⌘Q）后重新执行本脚本。" >&2
  exit 1
fi

echo "2/4 停止后台 Host"
if command -v areal >/dev/null 2>&1; then
  areal host stop >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -f "areal host run" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -f "areal host run" >/dev/null 2>&1; then
    echo "Host 仍在运行（可能有任务未结束）。等任务结束后执行 areal host stop，再重新执行本脚本。" >&2
    exit 1
  fi
else
  echo "未找到 areal 命令，跳过；桌面应用退出时会一起停止它管理的 Host。"
fi

echo "3/4 备份到 $BACKUP"
mkdir -p "$BACKUP"
copied=0
for source in "$AREAL_HOME" "$GUI_DATA"; do
  if [ -d "$source" ]; then
    ditto "$source" "$BACKUP/$(basename "$source")"
    copied=1
  fi
done
if [ "$copied" = 0 ]; then
  echo "没有找到旧数据目录，无需备份。"
  rmdir "$BACKUP" 2>/dev/null || true
fi
printf '%s\n' "backupAt=$STAMP" "arealHome=$AREAL_HOME" "guiData=$GUI_DATA" >"$BACKUP/备份说明.txt" 2>/dev/null || true

echo "4/4 完成"
cat <<EOF

现在可以安装并打开新版本。首次启动会一次性导入：
  保留：项目列表、会话历史、资料库、凭据与模型设置、定时任务定义、工作区登记、桌面偏好。
  需要重做：手机配对（在新版里重新扫码）、推送注册；进行中的任务需要重新发起；用量统计从零开始。
新版本不支持降级。如需回到旧版，先退出新版，再用备份目录覆盖：
  $BACKUP
EOF
