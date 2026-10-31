import { Button } from "./components/ui/button.js";
import { useI18n } from "./i18n/IntlProvider.js";

export function TaskCatalogNotice({
  projectName,
  error,
  disabled,
  onUpdate,
}: {
  projectName: string;
  error?: string;
  disabled: boolean;
  onUpdate: () => void;
}) {
  const { t } = useI18n();
  // 缓存行在各自的行尾标“上次记录”；这里只在读取失败时出现，避免列表顶部随读取状态跳动。
  if (!error) return null;
  return (
    <div className="task-catalog-error">
      <p role="status">
        {projectName} · {t("operations.schedules.readFailed")}
      </p>
      <p>{error}</p>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onUpdate}>
        {t("operations.schedules.refreshProject")}
      </Button>
    </div>
  );
}
