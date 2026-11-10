import { useState } from "react";
import type { Blocker } from "../shared/contracts.ts";
import { renderMessageHtml } from "./artifact/markdown.ts";
import { CopyId } from "./copy-id.tsx";
import { taskAnswer, taskQuestions } from "./task-questions.ts";
import { Button } from "./ui.tsx";
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
  clear,
}: {
  blocker: Blocker;
  busy: boolean;
  answer: (body: string) => void;
  clear: () => void;
}) {
  const form = taskQuestions(blocker.body);
  const [choices, setChoices] = useState<Record<number, string>>({}),
    [free, setFree] = useState<Record<number, string>>({});
  const answers =
    form?.questions.map((q, i) =>
      choices[i] === "free" ? (free[i] ?? "").trim() : (q.options[Number(choices[i])] ?? ""),
    ) ?? [];
  if (blocker.cleared_at)
    return (
      <details className="blocker-row answered">
        <summary>Cleared · {new Date(blocker.cleared_at).toLocaleString()}</summary>
        <TaskMarkdown body={form?.description || blocker.body} />
        {blocker.resolution_comment_id && (
          <p>
            Saved as comment <CopyId value={blocker.resolution_comment_id} />.
          </p>
        )}
      </details>
    );
  return (
    <div className="blocker-row">
      <TaskMarkdown body={form ? form.description : blocker.body} />
      <small>Waiting on {blocker.waiting_on}</small>
      {blocker.waiting_on === "task" ? (
        <p className="muted small">
          {blocker.satisfied
            ? "Prerequisite completed."
            : "Waiting for the prerequisite to be resolved."}
        </p>
      ) : form ? (
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
            Answers are saved as comments. Clear the blocker explicitly when its condition is
            satisfied.
          </p>
          <button type="submit" disabled={busy || !answers.every(Boolean)}>
            Post answers
          </button>
        </form>
      ) : null}
      {blocker.waiting_on !== "task" && (
        <Button variant="quiet" disabled={busy} onClick={clear}>
          Clear blocker
        </Button>
      )}
    </div>
  );
}
