import { useState } from "react";
import { Button, Input, Textarea } from "@areal/ui";
import { useI18n } from "../i18n/IntlProvider.js";
import type { Data } from "../services.js";
import type { MobileCommands } from "./mobile-commands.mjs";

export function MobileDecision({
  item,
  commands,
  busy,
}: {
  item: Data;
  commands: MobileCommands;
  busy: boolean;
}) {
  const { t } = useI18n();
  const [review, setReview] = useState<Awaited<ReturnType<MobileCommands["readDecision"]>>>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const approval = item.kind === "approval";
  const questions: Data[] = review?.body.questions ?? [];
  const complete =
    questions.length > 0 && questions.every((question) => answers[question.id]?.trim());
  const load = async () => {
    setLoading(true);
    setFailed(false);
    try {
      setReview(await commands.readDecision(item));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  const submit = async (response: string | Record<string, string>) => {
    if (review && (await commands.respond(review, response))) setSubmitted(true);
  };

  return (
    <section className="flex shrink-0 flex-col gap-inline rounded-card border border-border p-field">
      <h3 className="text-fixed-emphasis">
        {t(approval ? "mobile.decisionApproval" : "mobile.decisionQuestion")}
      </h3>
      {submitted ? (
        <p role="status">{t("mobile.decisionSubmitted")}</p>
      ) : review ? (
        <>
          <div className="max-h-[34dvh] overflow-auto overscroll-contain">
            {approval ? (
              <>
                <p className="text-fixed-control font-medium">{review.body.tool}</p>
                <pre className="my-inline whitespace-pre-wrap break-words text-fixed-caption">
                  {JSON.stringify(review.body.effectiveArguments, null, 2)}
                </pre>
                {review.body.effectivePermissions && (
                  <pre className="whitespace-pre-wrap break-words text-fixed-caption">
                    {JSON.stringify(review.body.effectivePermissions, null, 2)}
                  </pre>
                )}
              </>
            ) : (
              questions.map((question) => (
                <fieldset
                  className="mb-field flex flex-col gap-inline"
                  key={question.id}
                  disabled={busy}
                >
                  <legend className="font-medium">{question.title}</legend>
                  {(question.options ?? []).map((option: string) => (
                    <label
                      key={option}
                      className="flex min-h-[var(--size-touch-target)] items-center gap-inline"
                    >
                      <Input
                        unstyled
                        type="radio"
                        name={`${item.interactionId}-${question.id}`}
                        checked={answers[question.id] === option}
                        onChange={() => setAnswers((old) => ({ ...old, [question.id]: option }))}
                      />
                      {option}
                    </label>
                  ))}
                  {question.allowFreeText && (
                    <Textarea
                      aria-label={question.title}
                      placeholder={t("mobile.decisionCustomAnswer")}
                      value={
                        (question.options ?? []).includes(answers[question.id])
                          ? ""
                          : (answers[question.id] ?? "")
                      }
                      onChange={(event) =>
                        setAnswers((old) => ({ ...old, [question.id]: event.target.value }))
                      }
                    />
                  )}
                </fieldset>
              ))
            )}
          </div>
          <div className="flex justify-end gap-inline">
            <Button variant="ghost" disabled={busy} onClick={() => setReview(undefined)}>
              {t("mobile.cancel")}
            </Button>
            {approval ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void submit("deny")}>
                  {t("mobile.decisionDeny")}
                </Button>
                <Button disabled={busy} onClick={() => void submit("allowOnce")}>
                  {t("mobile.decisionAllow")}
                </Button>
              </>
            ) : (
              <Button disabled={busy || !complete} onClick={() => void submit(answers)}>
                {t("mobile.decisionReply")}
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          {failed && <p role="alert">{t("mobile.decisionReadFailed")}</p>}
          <Button
            variant="outline"
            className="self-start"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            {t(loading ? "mobile.loading" : "mobile.decisionDetails")}
          </Button>
        </>
      )}
    </section>
  );
}
