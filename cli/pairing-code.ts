export async function readPairingCode(fromStdin: boolean) {
  const input = process.stdin;
  if (!fromStdin && !input.isTTY)
    throw new Error(
      "Use an interactive terminal, or pass --pairing-code-stdin to read the code from standard input.",
    );
  const raw = input.isTTY && !fromStdin;
  const wasRaw = input.isRaw;
  if (raw) input.setRawMode(true);
  if (!fromStdin) process.stderr.write("Pairing code (hidden): ");
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error) => {
        input.off("data", data);
        input.off("end", end);
        input.off("error", fail);
        input.pause();
        if (error) reject(error);
        else if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.trim()))
          reject(new Error("Enter the CLI pairing code from Allgather."));
        else resolve(value.trim());
      };
      const data = (chunk: Buffer) => {
        for (const char of chunk.toString()) {
          if (char === "\u0003" || char === "\u0004") return finish(new Error("Login cancelled."));
          if (char === "\n" || char === "\r") return finish();
          if (raw && (char === "\u007f" || char === "\b")) value = value.slice(0, -1);
          else value += char;
          if (value.length > 256) return finish(new Error("Pairing code is too long."));
        }
      };
      const end = () => finish();
      const fail = (error: Error) => finish(error);
      input.on("data", data);
      input.once("end", end);
      input.once("error", fail);
      input.resume();
    });
  } finally {
    if (raw) input.setRawMode(wasRaw);
    if (!fromStdin) process.stderr.write("\n");
  }
}
