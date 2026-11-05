/** A4 过渡开关：手机与远程网页改用与桌面同一份界面。默认关，旧页面照常工作，验收后再删旧页面。 */
export function sharedUiEnabled() {
  try {
    return localStorage.getItem("areal.oneProtocol.sharedUi") === "1";
  } catch {
    return false;
  }
}
