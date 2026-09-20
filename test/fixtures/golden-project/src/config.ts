export const config = {
  port: parseInt(process.env.PORT || "3000"),
  debug: process.env.DEBUG === "true",
  dbUrl: process.env.DATABASE_URL || "sqlite://local.db",
};
