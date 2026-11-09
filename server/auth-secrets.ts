import { createHash, randomBytes } from "node:crypto";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
