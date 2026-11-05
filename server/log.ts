export function log(
  level: "info" | "error",
  event: string,
  fields: Record<string, string | number> = {},
): void {
  process.stderr.write(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      event,
      ...fields,
    }) + "\n",
  );
}
