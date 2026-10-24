// Adapted from ZCode platform.ts. See UPSTREAM.json and NOTICE.
export type ChromeBrowserDataImportError =
  | "chrome_sqlite_unavailable"
  | "chrome_profile_not_found"
  | "chrome_profile_ambiguous"
  | "chrome_executable_not_found"
  | "chrome_cookie_access_denied"
  | "chrome_cookie_elevation_required"
  | "chrome_cookie_elevation_cancelled"
  | "chrome_cookie_helper_verification_failed"
  | "chrome_cookie_app_bound_decryption_failed"
  | "chrome_cookie_protection_unsupported"
  | "chrome_profile_locked"
  | "chrome_local_storage_import_failed"
  | "chrome_import_not_supported"
  | "chrome_browser_data_import_unavailable"
  | "chrome_data_import_failed"
  | "chrome_default_profile_not_found";

/** Chrome 浏览器数据导入只返回数量和状态；Cookie/LocalStorage 值和解密材料不得跨进程。 */
export interface ChromeBrowserDataImportResult {
  success: boolean;
  cookies: {
    imported: number;
    skipped: number;
    failed: number;
  };
  localStorage: {
    originsImported: number;
    entriesImported: number;
    originsSkipped: number;
    originsFailed: number;
    error?: ChromeBrowserDataImportError;
  };
  /** 部分成功时保留可操作问题；不得包含 Profile 绝对路径或站点数据。 */
  issues?: ChromeBrowserDataImportError[];
  error?: ChromeBrowserDataImportError;
}
