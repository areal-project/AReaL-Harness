import { useMemo } from "react";
import { useI18n } from "./i18n/IntlProvider.js";
import { parseDelimitedPreview } from "./workspaceDelimited.js";

export function WorkspaceDelimitedPreview({
  text,
  delimiter,
}: {
  text: string;
  delimiter: "," | "\t";
}) {
  const { t } = useI18n();
  const result = useMemo(() => parseDelimitedPreview(text, delimiter), [text, delimiter]);
  if (result.malformed)
    return (
      <p role="alert" className="p-3 text-ui-sm text-destructive">
        {t("resources.tableMalformed")}
      </p>
    );
  return (
    <div className="p-3">
      {result.truncated && (
        <p role="status" className="pb-2 text-ui-sm text-foreground-subtle">
          {t("resources.tableBound")}
        </p>
      )}
      <table className="w-full border-collapse text-ui-sm" aria-label={t("resources.table")}>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index}>
              <th
                scope="row"
                className="border border-border px-2 py-1 text-right font-normal text-foreground-subtle"
              >
                {index + 1}
              </th>
              {row.map((cell, column) => (
                <td key={column} className="border border-border px-2 py-1 whitespace-pre-wrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
