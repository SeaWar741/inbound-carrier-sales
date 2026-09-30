"use client";

import { LuArrowRight, LuRadioTower } from "react-icons/lu";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode }),
    }).catch(() => null);
    setPending(false);
    if (res?.ok) return router.replace("/");
    setError(res?.status === 401 ? "That passcode is not right." : "Could not reach the tower. Try again.");
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-10 flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-full bg-accent-soft text-accent">
            <LuRadioTower size={18} />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Control Tower</h1>
            <p className="text-sm text-fg-muted">Inbound carrier sales, live</p>
          </div>
        </div>
        <label htmlFor="passcode" className="mb-2 block text-sm text-fg-muted">
          Operator passcode
        </label>
        <input
          id="passcode"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          className="tabular w-full rounded-[var(--radius-panel)] border border-line-strong bg-panel px-3 py-2.5 text-fg outline-none transition-colors focus:border-accent"
        />
        <p role="alert" className="mt-2 min-h-5 text-sm text-risk">
          {error}
        </p>
        <button
          type="submit"
          disabled={pending || passcode.length === 0}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white transition active:scale-[0.98] disabled:opacity-40"
        >
          {pending ? "Checking" : "Enter"}
          <LuArrowRight size={16} />
        </button>
      </form>
    </main>
  );
}
