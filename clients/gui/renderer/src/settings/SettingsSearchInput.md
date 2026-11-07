# SettingsSearchInput 合同

`R-SETTINGSSEARCHINPUT-004` 本次仅准入现有 search-lg 变体。输入保留 `type=search` 的搜索框语义，尺寸与文字沿原组件及宿主样式。调用方提供可读标签和清除动作名称。查询非空、可用且有清除回调时才显示清除按钮；禁用时不能编辑或清除。清除只请求调用方更新查询，不重置业务选择、目录或提交。
