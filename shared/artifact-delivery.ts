export interface ArtifactDelivery {
  id: string;
  event: "submitted" | "archived";
  state: string;
  acknowledgement: "adapter" | "harness" | "transport" | "pty_submission" | null;
  route: "managed" | "message";
  command_id: string | null;
  dispatch_state: string | null;
  turn_state: "completed" | "cancelled" | "failed" | null;
  message: string;
  updated_at: string;
}
export interface ArtifactNotificationSource {
  kind: "artifact_notification";
  notification_id: string;
  artifact_id: string;
  registration_id: string;
  event: "submitted" | "archived";
  fingerprint: string;
  lifecycle_event_id: string | null;
  comment_id: string | null;
}
