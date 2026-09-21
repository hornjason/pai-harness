// API server — route definitions
const app = { get: (_p: string, _h: Function) => {}, post: (_p: string, _h: Function) => {} };

app.get("/api/health", () => ({ status: "ok" }));
app.get("/api/users", () => ({ users: [] }));
app.post("/api/users", () => ({ created: true }));

export const VERSION = "1.0.0";
