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
Watch wakes on Submit or immediately for already pending comments. Opening or closing the stream does not acknowledge delivery.
API: POST /api/artifacts/ID/watch with JSON timeout_ms (0 means unlimited) and optional operator metadata. Requires artifacts:read and artifacts:notify; SSE events are ready, heartbeat, result, or error.
Watch exits: 10 delivered, 0 archived, 2 timeout, 4 superseded, cancelled, or acknowledgment conflict. Handle nonzero exits explicitly.
List: artifact list [--meta key=value] [--mine]; mine matches meta.session to the current agent session.
Search: artifact search QUERY [--attention] [--type all|content|conversation] [--history latest|all]
Downloads stream original bytes unless --output FILE is supplied. Existing output files are protected.
Uncertain writes: retain the original --key, captured bytes, metadata and printed concurrency guards.
Create uses separate retry keys for creation and publication; recovery reports the artifact ID when known.
Use artifact guide files|html|diff for preparation. --input and --body-file accept - for stdin.
Allgather keeps its owner authorization, project grants and Tower notifications. GC is a dry run unless --apply.`;
const formats: Record<string, string> = {
  files: `Prepare a directory containing the complete files to review. Use --root DIR and repeat --path PATH to select membership; the default is the whole directory. --ref REF captures selected Git paths. Publish complete snapshots, not incremental edits. Binary files download as original bytes; source reads require UTF-8.`,
  html: `Prepare index.html and its relative assets in one directory, then create --kind html --root DIR. Build before capture. Use relative image and stylesheet URLs; keep required assets inside the capture. Avoid machine-local URLs and credentials. For canvas pixel reads or export, set image.crossOrigin to anonymous before src, including for captured images in the isolated preview. Remote images also need appropriate CORS headers; a tainted canvas cannot export. Verify the published preview before sharing.`,
  diff: `Use create --kind diff --patch FILE, --commit SHA, or --base REF [--head REF|WORKING|STAGED]. Patch files must be UTF-8; --patch - reads stdin. Each version is an independent unified diff. Targets name the captured file, version, old/new side, line range and exact quote.`,
};
export function artifactGuide(topic?: string) {
  if (!topic) return workflow;
  if (!formats[topic]) throw new Error("Use artifact guide files|html|diff");
  return formats[topic];
}
