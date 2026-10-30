/** One URL contract for Prisma and runtime; never return credential-bearing errors. */
export function mysqlConnectionOptions(raw: string) {
  try {
    const url = new URL(raw);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      url.protocol !== "mysql:" ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(database) ||
      url.search ||
      url.hash
    ) throw new Error();
    const port = Number(url.port || 3306);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    const user = decodeURIComponent(url.username);
    if (["root", "mysql.sys", "mysql.session", "mysql.infoschema"].includes(user.toLowerCase()))
      throw new Error();
    return {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port,
      user,
      password: decodeURIComponent(url.password),
      database,
    };
  } catch {
    throw new Error("DATABASE_URL must select MySQL with a dedicated application identity, database, and no connection overrides.");
  }
}
