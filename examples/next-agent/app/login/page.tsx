"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

/** Minimal email + password sign-in so the example runs end to end. */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const go = async (mode: "in" | "up") => {
    const auth = supabaseBrowser().auth;
    const { error } = mode === "in" ? await auth.signInWithPassword({ email, password }) : await auth.signUp({ email, password });
    if (error) return setMsg(error.message);
    location.assign("/");
  };
  return (
    <form onSubmit={(e) => (e.preventDefault(), void go("in"))} style={{ display: "grid", gap: 8, maxWidth: 320 }}>
      <h1>Sign in</h1>
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button type="submit">Sign in</button>
      <button type="button" onClick={() => void go("up")}>Create account</button>
      {msg ? <p role="alert">{msg}</p> : null}
    </form>
  );
}
