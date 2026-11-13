const workflow = `Allgather artifact workflow
Create and publish: allgather artifact create --kind files --root ./prepared --title Review
Metadata-only: allgather artifact create --kind files --title Review
Update: allgather artifact publish ID --root ./prepared --expected-seq N --key KEY
Inspect: artifact show ID; artifact versions ID; artifact files ID --version N
Read: artifact source ID --path FILE --version N; artifact download ID --path FILE
Review: artifact comments ID; artifact thread-add ID --body TEXT; artifact comment THREAD --body TEXT
Target: --file PATH --version N --view source --line 2-4 --quote 'exact excerpt'
Rendered: --file index.html --version N --view rendered --selector CSS [--route QUERY_OR_HASH]
Diff: --file PATH --version N --view diff --line 2-4 --quote TEXT --side old|new
Images: --attach IMAGE (repeat up to four); edits replace images; --clear-attachments removes them.
Media: --target JSON with kind media, versionSeq, path, locator {time, box}; --frame PNG_OR_JPEG.
Move: artifact reanchor THREAD --file PATH --version N --view source --line 2-4
Bulk: artifact reanchor ARTIFACT --input FILE (object with expectedSeq and items).
Array bulk: artifact reanchor --artifact ID --version N --input FILE_OR_DASH
Reanchor preserves original evidence. --expected-anchor N guards an earlier read.
Targeted replies to the latest version move the anchor atomically; historical replies stay pinned.
Pending fetch acknowledges only after output and image saves succeed, then attempts a Tower subscription.
--all reads history without acknowledgment or subscribing; --no-ack leaves delivery pending.
Watch: artifact watch ID [--timeout SECONDS]. Uses SSE and becomes the explicit recipient, replacing an earlier watch or explicit Tower listener. A retained fallback resumes when watch ends.
Without a session ID, watch and its delivery acknowledgment are attributed to the owner; permissions still come from the authenticated connection.
Watch wakes on Submit or immediately for already pending comments. Opening or closing the stream does not acknowledge delivery.
API: POST /api/artifacts/ID/watch with JSON timeout_ms (0 means unlimited) and optional operator metadata. Requires artifacts:read and artifacts:notify; SSE events are ready, heartbeat, result, or error.
Watch exits: 10 delivered, 0 archived, 2 timeout, 4 superseded, cancelled, or acknowledgment conflict. Handle nonzero exits explicitly.
List: artifact list [--meta key=value] [--mine]; mine matches meta.session to the current agent session.
Search: artifact search QUERY [--attention] [--type all|content|conversation] [--history latest|all]
Downloads stream original bytes unless --output FILE is supplied. Existing output files are protected.
Uncertain writes: retain the original --key, captured bytes, metadata and printed concurrency guards.
Create uses separate retry keys for creation and publication; recovery reports the artifact ID when known.
Use artifact guide files|html|diff|page-utility for preparation. --input, --body-file, --patch, and text fields such as --title, --summary and --body accept - for stdin; only one input may read stdin.
Source reads return the complete supported text or binary/oversize metadata by default; --start/--limit select bounded text reads.
GC accepts --ttl 30d and exits nonzero for partial failures. Set the server default with allgather-server config set archiveTtlDays 30, then restart.
Allgather keeps its owner authorization, project grants and Tower notifications. GC is a dry run unless --apply.`;
const formats: Record<string, string> = {
  files: `Prepare a directory containing the complete files to review. Use --root DIR and repeat --path PATH to select membership; the default is the whole directory. --ref REF captures selected Git paths. Publish complete snapshots, not incremental edits. Binary files download as original bytes; source reads require UTF-8.`,
  html: `Prepare index.html and its relative assets in one directory, then create --kind html --root DIR. Build before capture. Use relative image and stylesheet URLs; keep required assets inside the capture. Avoid machine-local URLs and credentials. For canvas pixel reads or export, set image.crossOrigin to anonymous before src, including for captured images in the isolated preview. Remote images also need appropriate CORS headers; a tainted canvas cannot export. Artifact localStorage persists across reloads and versions, isolated from other artifacts and app settings, with a 256 KiB / 1,024-key quota. Logout and deletion clear it. Native download links and export buttons work in the preview. Nested browsing contexts and workers are blocked: <iframe src>, <object>, <embed>, and Worker do not load, even for published files. Render device mockups and embedded screens directly in the page, using container queries for a phone width, or inside an open shadow root so rendered threads can still anchor there. Links that leave the artifact need absolute http(s) URLs. A link to another artifact on this server (/artifact-workspace/ID or /?view=artifacts&artifact=ID) opens it in Allgather; other links, and links a reader opens in a new tab, open in a new browser tab. Links to other sites first ask the reader to confirm the full address. Scripts cannot open links without a click. For a page that collects choices for you or adapts to comment mode, read artifact guide page-utility. Verify the published preview before sharing.`,
  "page-utility": `Page utility
Read this before building an HTML artifact that collects input or adapts to comment mode; artifact guide html covers preparing the page itself. The human chooses from options in the page and the page submits those choices back to you. Each choice arrives as a thread through artifact comments ID.

Load: <script type="module">import r3 from "/r3/utility.js";</script>
The workspace serves the module to every published HTML page and it is ready before the first script runs. Use exactly this specifier; a static import and await import("/r3/utility.js") both work. The module exists only in the artifact workspace; a page that should also open from disk uses the dynamic import inside try/catch and stays readable without it.

Collect and submit:
<form id="rollout">
  <fieldset id="rollout-question">
    <legend>How should we roll out the migration?</legend>
    <label><input type="radio" name="plan" value="staged" required> Staged, 10% per day</label>
    <label><input type="radio" name="plan" value="all"> All at once</label>
  </fieldset>
  <button type="button" id="send-choice">Send to agent</button>
  <p id="send-status" role="status"></p>
</form>
<script type="module">
import r3 from "/r3/utility.js";
const form = document.querySelector("#rollout"), button = document.querySelector("#send-choice");
button.onclick = async () => {
  if (!form.reportValidity()) return;
  button.disabled = true;
  try {
    await r3.createThread({ body: "Rollout plan: " + new FormData(form).get("plan"), locator: { selector: "#rollout-question" } });
    const { notification } = await r3.submit();
    document.querySelector("#send-status").textContent = notification.state === "none" ? "Saved. No agent is listening yet." : "Sent to the agent.";
  } catch (error) {
    document.querySelector("#send-status").textContent = error.message;
    button.disabled = false;
  }
};
</script>

Rules:
1. Start from a click or key press on a type="button" control; the preview has no native form submission. createThread, comment and submit act as the signed-in owner and are accepted only during a recent user action, so call them first and one after another.
2. Write a body that stands alone: name the question and the chosen option by its stable value and include free text. Bodies render as Markdown.
3. Anchor the thread with locator.selector on a unique, stable id; omit locator for the whole page.
4. Call submit() last. It sends every pending comment on the artifact, exactly as the workspace Submit button does.
5. Disable the control while calls run; every createThread call creates a new thread.
6. Show each rejection's message in the page and re-enable the control for retry.
Use one thread per independent question, or one thread for a single decision. Add to an existing thread with comment({ threadId, body }).

Methods:
getContext() -> {artifactId, versionSeq, path, resourceRoot, representation, state}; enable input only while state is active.
getThreads() -> every thread on the artifact: {id, status open|resolved, target, createdAt, updatedAt, comments[{id, author {role human|agent, sessionId}, body, createdAt, sentAt}]}.
createThread({body, locator?}) -> the new thread. comment({threadId, body}) -> the new comment. Exactly these keys; body is 1 to 1,048,576 characters. locator takes selector with optional shadowHosts, ancestors, quote, prefix, suffix, route (starting with ? or #) and viewport.
submit() -> {notification: {state}}; sent or queued when you were notified, none when no agent is listening. It rejects when delivery fails and leaves comments pending.
subscribe(listener) calls listener() after workspace updates; read getThreads() again inside it to restore answered questions and show agent replies.
isCommentMode() returns a boolean immediately; onCommentModeChange(listener) calls listener(on) when the mode changes. Both return immediately; subscriptions return an unsubscribe function.
Keep unsent draft state in localStorage.

Comment mode: clicks select elements to comment on, so page click handlers do not run. While it is on, the <html> element has the r3-comment-mode class; use it to reveal content that normally needs a click, for example .r3-comment-mode [role="tabpanel"][hidden] { display: block; }. For script changes, apply r3.isCommentMode() and pair it with r3.onCommentModeChange(apply). The plain c key toggles comment mode from inside the page outside editable fields; leave it unbound.

After publishing, tell the human the page sends their choices when they press its button. Read them with artifact comments ID and reply with artifact comment THREAD --body TEXT after acting on them.`,
  diff: `Use create --kind diff --patch FILE, --commit SHA, or --base REF [--head REF|WORKING|STAGED]. Patch files must be UTF-8; --patch - reads stdin. Each version is an independent unified diff. Targets name the captured file, version, old/new side, line range and exact quote.`,
};
export function artifactGuide(topic?: string) {
  if (!topic) return workflow;
  if (!formats[topic]) throw new Error("Use artifact guide files|html|diff|page-utility");
  return formats[topic];
}
