import { useState } from "react";
import { renderMessageHtml } from "../server/r3/web/src/markdown.ts";
import type { Blocker } from "../shared/contracts.ts";
import { taskAnswer, taskQuestions } from "./task-questions.ts";
export function TaskMarkdown({ body }: { body: string }) {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderer disables HTML and unsafe URLs
    <div className="task-markdown" dangerouslySetInnerHTML={{ __html: renderMessageHtml(body) }} />
  );
}
export function TaskBlocker({
  blocker,
  busy,
  answer,
  resolve,
}: {
  blocker: Blocker;
  busy: boolean;
  answer: (body: string) => void;
  resolve: () => void;
}) {
  const form = taskQuestions(blocker.body);
  const [choices, setChoices] = useState<Record<number, string>>({}),
    [free, setFree] = useState<Record<number, string>>({});
  const answers =
    form?.questions.map((q, i) =>
      choices[i] === "free" ? (free[i] ?? "").trim() : (q.options[Number(choices[i])] ?? ""),
    ) ?? [];
  if (blocker.resolved_at)
    return (
      <details className="blocker-row answered">
        <summary>Answered · {new Date(blocker.resolved_at).toLocaleString()}</summary>
        <TaskMarkdown body={form?.description || blocker.body} />
        {blocker.resolved_comment_id && (
          <p>
            Saved as comment <code>{blocker.resolved_comment_id}</code>.
          </p>
        )}
      </details>
    );
  return (
    <div className="blocker-row">
      <TaskMarkdown body={form ? form.description : blocker.body} />
      <small>Waiting on {blocker.waiting_on}</small>
      {form ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (answers.every(Boolean)) answer(taskAnswer(form.questions, answers));
          }}
        >
          {form.questions.map((q, i) => (
            <fieldset key={q.question}>
              <legend>{q.question}</legend>
              {q.options.map((option, index) => (
                <label key={option} className="permission-choice">
                  <input
                    type="radio"
                    name={`${blocker.id}:${i}`}
                    value={index}
                    checked={choices[i] === String(index)}
                    onChange={() => setChoices({ ...choices, [i]: String(index) })}
                  />
                  <span>{option}</span>
                </label>
              ))}
              <label className="permission-choice">
                <input
                  type="radio"
                  name={`${blocker.id}:${i}`}
                  value="free"
                  checked={choices[i] === "free"}
                  onChange={() => setChoices({ ...choices, [i]: "free" })}
                />
                <span>Write another answer</span>
              </label>
              {choices[i] === "free" && (
                <textarea
                  aria-label={`Answer: ${q.question}`}
                  maxLength={4000}
                  value={free[i] ?? ""}
                  onChange={(event) => setFree({ ...free, [i]: event.target.value })}
                />
              )}
            </fieldset>
          ))}
          <p className="muted small">
            Confirm adds your answers as a comment and resolves this wait, including when you
            decline or request changes.
          </p>
          <button type="submit" disabled={busy || !answers.every(Boolean)}>
            Confirm answers
          </button>
        </form>
      ) : (
        <button type="button" className="quiet" disabled={busy} onClick={resolve}>
          Resolve
        </button>
      )}
    </div>
  );
}
