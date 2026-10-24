# SettingsSearchInput 合同

[SettingsSearchInput.tsx](SettingsSearchInput.tsx) 组合生产 Input、Button 与既有搜索、清除图标。标签、当前查询与变更动作来自调用方，组件不读取目录或执行管理动作。[PluginCenter.tsx](PluginCenter.tsx) 是本次资源切片消费者。

本次仅准入现有 search-lg 变体。输入保留 `type=search` 的搜索框语义，尺寸与文字沿原组件及宿主样式。调用方提供可读标签和清除动作名称。查询非空、可用且有清除回调时才显示清除按钮；禁用时不能编辑或清除。清除只请求调用方更新查询，不重置业务选择、目录或提交。

Tab 可到达输入及可用清除按钮，Enter 与 Space 沿 Button 语义激活清除。焦点与搜索文本应在代表主题、字号和宽窄条件下可读。Props 以源码类型为准，本合同不建立第二份接口表。

本次准入的空查询、输入、清除与键盘状态需要实际运行证据。资源目录过滤、异步读取、详情往返与提交恢复归 PluginCenter；原任务返回归 App。当前验证与范围见[插件资源切片](../../../../../design/patterns/plugin-resources.md)。
