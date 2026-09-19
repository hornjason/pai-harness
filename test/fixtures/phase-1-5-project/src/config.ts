export function getConfig() {
  return {
    port: parseInt(process.env.PORT || "3000", 10),
    dbUrl: process.env.DATABASE_URL || "sqlite://local.db",
    debug: process.env.DEBUG === "true",
  };
}
