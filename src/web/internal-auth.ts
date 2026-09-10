import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyInternalIdentity(headers: Headers, method: string, path: string, body = "", now = Date.now()): string | undefined {
  const secret = process.env.WALRY_INTERNAL_SECRET;
  const user = headers.get("x-walry-user");
  const timestamp = headers.get("x-walry-time") ?? "";
  const signature = headers.get("x-walry-signature") ?? "";
  if (!secret || !user || user.length > 200 || /[\r\n]/u.test(user) || !/^\d+$/u.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 || !/^[a-f0-9]{64}$/u.test(signature)) return undefined;
  const expected = createHmac("sha256", secret).update([timestamp, user, method.toUpperCase(), path, body].join("\n")).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? user : undefined;
}
