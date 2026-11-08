export function suggestedProjectSlug(name: string): string {
  if (name.trim().toLowerCase() === "catchlight") return "CL";
  const words =
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toUpperCase()
      .match(/[A-Z0-9]+/g) ?? [];
  const value = words.length > 1 ? words.map((word) => word[0]).join("") : words[0]?.slice(0, 3);
  return (value && /^[A-Z]/.test(value) ? value : `P${value ?? ""}`).slice(0, 10);
}
