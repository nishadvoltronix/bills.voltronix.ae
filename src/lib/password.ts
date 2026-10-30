import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

const PARAMETERS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, PARAMETERS, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 128)
    throw new Error("Passwords must contain 12 to 128 characters.");
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$32768$8$3$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  if (password.length > 128) return false;
  const [method, n, r, p, saltHex, keyHex, extra] = encoded.split("$");
  if (
    method !== "scrypt" ||
    n !== "32768" ||
    r !== "8" ||
    p !== "3" ||
    extra !== undefined ||
    !/^[a-f0-9]{32}$/.test(saltHex ?? "") ||
    !/^[a-f0-9]{128}$/.test(keyHex ?? "")
  )
    return false;
  const key = await derive(password, Buffer.from(saltHex, "hex"));
  return timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}
