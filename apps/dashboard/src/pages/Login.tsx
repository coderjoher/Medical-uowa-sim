import { useState } from "react";
import { api, ApiError, token, type Me } from "../api.js";

export function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="center">
      <form
        className="card narrow"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            const r = await api<{ token: string; user: Me }>("POST", "/api/auth/login", { username, password });
            if (r.user.role === "student") return setError("Students use the simulation app, not the dashboard.");
            token.set(r.token);
            onLogin(r.user);
          } catch (err) {
            setError(err instanceof ApiError && err.status === 401 ? "Wrong username or password." : "Cannot reach the server.");
          }
        }}
      >
        <h1>Simulation dashboard</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <button className="primary" type="submit">
          Sign in
        </button>
        <p className="error" role="alert">
          {error}
        </p>
      </form>
    </div>
  );
}
