import { useRef, useState } from "react";
import { rawText } from "./errors/errorCopy.js";
import { Input, Switch, Textarea } from "@areal/ui";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";
import {
  call,
  type CommandParams,
  type CommandResponse,
  type PlatformServices,
} from "./services.js";

type Report = NonNullable<CommandResponse<"bugReport">["report"]>;
type Summary = NonNullable<CommandResponse<"bugReport">["reports"]>[number];

async function screenshot(file: File) {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error("image");
  const image = await createImageBitmap(file);
  try {
    if (image.width > 4096 || image.height > 4096) throw new Error("image");
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image");
    context.drawImage(image, 0, 0);
    const data = canvas.toDataURL("image/png");
    if (data.length > 2796226) throw new Error("image");
    return data;
  } finally {
    image.close();
  }
}

export function BugReportDialog({
  open,
  onClose,
  services,
}: {
  open: boolean;
  onClose: () => void;
  services: PlatformServices;
}) {
  const { t } = useI18n();
  const [id, setId] = useState(() => crypto.randomUUID());
  const [description, setDescription] = useState("");
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<{ token: string; text: string }>();
  const [reports, setReports] = useState<Summary[] | null>(null);
  const [saved, setSaved] = useState<Report>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [expandedImage, setExpandedImage] = useState<number>();
  const picker = useRef<HTMLInputElement>(null);
  const command = (request: CommandParams<"bugReport">) => call(services, "bugReport", request);
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      const code = rawText(cause) ?? "";
      setError(
        t(
          code.includes("UPLOAD_TOO_LARGE")
            ? "bugReport.uploadTooLarge"
            : code.includes("UPLOAD_UNCONFIRMED")
              ? "bugReport.uploadUnconfirmed"
              : code.includes("CAPACITY")
                ? "bugReport.capacity"
                : code.includes("EXPIRED")
                  ? "bugReport.expired"
                  : code === "image" || code.includes("IMAGE_INVALID")
                    ? "bugReport.imageError"
                    : "bugReport.error",
        ),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const addImages = (files: File[]) =>
    void run(async () => {
      if (files.length + screenshots.length > 5) throw new Error("image");
      const added = await Promise.all(files.map(screenshot));
      setScreenshots((current) => [...current, ...added]);
    });
  const history = () =>
    void run(async () => {
      const result = await command({ operation: "list" });
      setReports(result.reports ?? []);
      setSaved(undefined);
      setDeleting(false);
    });
  const images = saved?.screenshots ?? screenshots;
  const diagnosticText = saved ? saved.diagnostics : diagnostics?.text;
  const submit = async (reportId: string) => {
    const result = await command({ operation: "submit", id: reportId });
    setSaved(result.report);
    setNotice("");
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !lock.current) onClose();
      }}
    >
      <DialogContent
        className="bug-report-dialog w-[min(640px,calc(100vw-32px))] max-w-[calc(100vw-32px)] max-h-[calc(100dvh-48px)] flex flex-col gap-[var(--spacing-field)]"
        showCloseButton={!busy}
        onPaste={(event) => {
          if (saved || reports || busy) return;
          const files = Array.from(event.clipboardData.files);
          if (files.length) {
            event.preventDefault();
            addImages(files);
          }
        }}
      >
        <DialogTitle>{t(reports && !saved ? "bugReport.history" : "bugReport.title")}</DialogTitle>
        <DialogDescription>{t("bugReport.local")}</DialogDescription>
        <div
          className="bug-report-body overflow-y-auto min-h-0 flex flex-col gap-[var(--spacing-field)]"
          aria-busy={busy}
        >
          {reports && !saved ? (
            <>
              {reports.length === 0 && <p>{t("bugReport.empty")}</p>}
              {reports.map((report) => (
                <div
                  className="bug-report-history-row flex items-center justify-between gap-[var(--spacing-inline)] py-[var(--spacing-inline)] border-b border-border [&_p]:text-foreground-subtle [&_p]:text-ui-caption [&_p]:leading-relaxed"
                  key={report.id}
                >
                  <div>
                    <time>{new Date(report.createdAt).toLocaleString()}</time>
                    <p>
                      {t("bugReport.summary", {
                        count: report.screenshotCount,
                        diagnostics: t(
                          report.hasDiagnostics ? "bugReport.included" : "bugReport.noDiagnostics",
                        ),
                      })}
                    </p>
                    {report.submittedId && (
                      <p>{t("bugReport.submitted", { id: report.submittedId })}</p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setSaved((await command({ operation: "read", id: report.id })).report);
                        setDeleting(false);
                      })
                    }
                  >
                    {t("bugReport.view")}
                  </Button>
                </div>
              ))}
            </>
          ) : (
            <>
              <label
                className="bug-report-field flex flex-col gap-[var(--spacing-inline)] [&>span]:flex [&>span]:items-center [&>span]:justify-between [&>span]:gap-[var(--spacing-inline)]"
                htmlFor="bug-description"
              >
                <span>
                  {t("bugReport.description")} {!saved && <span>{description.length}/4000</span>}
                </span>
                <Textarea
                  id="bug-description"
                  value={saved?.description ?? description}
                  readOnly={!!saved}
                  disabled={busy}
                  maxLength={4000}
                  rows={5}
                  placeholder={t("bugReport.placeholder")}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <section
                className="bug-report-images flex flex-col gap-[var(--spacing-inline)] [&>p]:text-foreground-subtle [&>p]:text-ui-caption [&>p]:leading-relaxed"
                aria-label={t("bugReport.screenshots")}
                onDragOver={(event) => {
                  if (!saved && !busy) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!saved && !busy) addImages(Array.from(event.dataTransfer.files));
                }}
              >
                <div className="bug-report-field-heading flex items-center justify-between gap-[var(--spacing-inline)]">
                  <strong>{t("bugReport.screenshots")}</strong>
                  <span>{images.length}/5</span>
                </div>
                {images.length > 0 && (
                  <div className="bug-report-thumbnails flex flex-wrap gap-[var(--spacing-inline)] [&>figure]:w-[100px] [&>figure]:m-0 [&>figure]:flex [&>figure]:flex-col [&>figure]:items-center [&_img]:w-[100px] [&_img]:h-[76px] [&_img]:object-contain [&_img]:border [&_img]:border-border [&_img]:rounded-control">
                    {images.map((image, index) => (
                      <figure key={`${index}:${image.slice(-20)}`}>
                        <Button
                          unstyled
                          className="bug-report-image-button cursor-zoom-in focus-visible:outline-2 focus-visible:outline-[var(--color-brand)] focus-visible:outline-offset-2"
                          aria-expanded={expandedImage === index}
                          aria-label={t("bugReport.imageAlt", { number: index + 1 })}
                          onClick={() =>
                            setExpandedImage((current) => (current === index ? undefined : index))
                          }
                        >
                          <img src={image} alt={t("bugReport.imageAlt", { number: index + 1 })} />
                        </Button>
                        {!saved && (
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={busy}
                            aria-label={t("bugReport.remove", { number: index + 1 })}
                            onClick={() =>
                              setScreenshots((current) => current.filter((_, i) => i !== index))
                            }
                          >
                            <Trash2 size={16} />
                          </Button>
                        )}
                      </figure>
                    ))}
                  </div>
                )}
                {expandedImage !== undefined && images[expandedImage] && (
                  <img
                    className="bug-report-expanded-image w-full h-auto object-contain"
                    src={images[expandedImage]}
                    alt={t("bugReport.imageAlt", { number: expandedImage + 1 })}
                  />
                )}
                {!saved && (
                  <>
                    <p>{t("bugReport.imageHint")}</p>
                    <Input
                      className="hidden"
                      aria-label={t("bugReport.add")}
                      ref={picker}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      hidden
                      onChange={(event) => {
                        addImages(Array.from(event.target.files ?? []));
                        event.target.value = "";
                      }}
                    />
                    <Button
                      variant="outline"
                      disabled={busy || images.length >= 5}
                      onClick={() => picker.current?.click()}
                    >
                      <ImagePlus size={16} />
                      {t("bugReport.add")}
                    </Button>
                  </>
                )}
              </section>
              <p className="bug-report-hint text-foreground-subtle text-ui-caption leading-relaxed">
                {t("bugReport.privacy")}
              </p>
              {!saved && (
                <label className="bug-report-consent flex items-center gap-[var(--spacing-inline)]">
                  <Switch
                    aria-label={t("bugReport.diagnostics")}
                    checked={!!diagnostics}
                    disabled={busy}
                    onCheckedChange={(checked) => {
                      if (!checked) {
                        setDiagnostics(undefined);
                        return;
                      }
                      void run(async () => {
                        const result = await command({ operation: "prepare" });
                        if (result.token && result.diagnostics)
                          setDiagnostics({ token: result.token, text: result.diagnostics });
                      });
                    }}
                  />
                  {t("bugReport.diagnostics")}
                </label>
              )}
              <p className="bug-report-hint text-foreground-subtle text-ui-caption leading-relaxed">
                {t("bugReport.diagnosticHint")}
              </p>
              {diagnosticText ? (
                <SettingsDisclosure title={t("bugReport.preview")}>
                  <pre className="bug-report-diagnostics max-h-[220px] overflow-auto whitespace-pre-wrap break-all text-ui-caption">
                    {diagnosticText}
                  </pre>
                </SettingsDisclosure>
              ) : (
                saved && <p>{t("bugReport.noDiagnostics")}</p>
              )}
            </>
          )}
          {saved?.submittedId && <p>{t("bugReport.submitted", { id: saved.submittedId })}</p>}
          {error && (
            <p role="alert" className="bug-report-error text-destructive">
              {error}
            </p>
          )}
          {(notice || busy) && <p role="status">{busy ? t("bugReport.busy") : notice}</p>}
          {deleting && <p>{t("bugReport.deleteHint")}</p>}
        </div>
        <footer className="bug-report-footer flex items-center flex-wrap gap-[var(--spacing-inline)] justify-between border-t border-border pt-[var(--spacing-field)] [&>div]:flex [&>div]:items-center [&>div]:flex-wrap [&>div]:gap-[var(--spacing-inline)]">
          <div>
            {reports && !saved ? (
              <Button variant="ghost" disabled={busy} onClick={() => setReports(null)}>
                {t("bugReport.back")}
              </Button>
            ) : (
              <Button variant="ghost" disabled={busy} onClick={history}>
                {t("bugReport.history")}
              </Button>
            )}
          </div>
          <div>
            {saved ? (
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setSaved(undefined);
                    setReports(null);
                    setId(crypto.randomUUID());
                    setDescription("");
                    setScreenshots([]);
                    setDiagnostics(undefined);
                    setNotice("");
                    setDeleting(false);
                  }}
                >
                  {t("bugReport.new")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!deleting) {
                      setDeleting(true);
                      return;
                    }
                    void run(async () => {
                      await command({ operation: "delete", id: saved.id });
                      if (saved.id === id) {
                        setId(crypto.randomUUID());
                        setDescription("");
                        setScreenshots([]);
                        setDiagnostics(undefined);
                      }
                      setSaved(undefined);
                      setReports((await command({ operation: "list" })).reports ?? []);
                      setDeleting(false);
                    });
                  }}
                >
                  {t(deleting ? "bugReport.deleteConfirm" : "bugReport.delete")}
                </Button>
                {deleting && (
                  <Button variant="ghost" onClick={() => setDeleting(false)}>
                    {t("bugReport.cancel")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={busy || deleting}
                  onClick={() =>
                    void run(async () => {
                      const result = await command({ operation: "export", id: saved.id });
                      if (!result.canceled) setNotice(t("bugReport.exported"));
                    })
                  }
                >
                  {t("bugReport.export")}
                </Button>
                {saved.state !== "submitted" && (
                  <Button
                    disabled={busy || deleting}
                    onClick={() => void run(() => submit(saved.id))}
                  >
                    {t("bugReport.submit")}
                  </Button>
                )}
              </>
            ) : (
              !reports && (
                <>
                  <Button variant="ghost" disabled={busy} onClick={onClose}>
                    {t("bugReport.close")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !description.trim()}
                    onClick={() =>
                      void run(async () => {
                        await command({
                          operation: "save",
                          id,
                          description,
                          screenshots,
                          ...(diagnostics ? { diagnosticsToken: diagnostics.token } : {}),
                        });
                        setSaved((await command({ operation: "read", id })).report);
                        setNotice(t("bugReport.saved"));
                      })
                    }
                  >
                    {t("bugReport.save")}
                  </Button>
                  <Button
                    disabled={busy || !description.trim()}
                    onClick={() =>
                      void run(async () => {
                        await command({
                          operation: "save",
                          id,
                          description,
                          screenshots,
                          ...(diagnostics ? { diagnosticsToken: diagnostics.token } : {}),
                        });
                        setSaved((await command({ operation: "read", id })).report);
                        await submit(id);
                      })
                    }
                  >
                    {t("bugReport.submit")}
                  </Button>
                </>
              )
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
